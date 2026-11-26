/**
 * Offline, deterministic tests for shell hooks (Tier-3 gap #12).
 *
 * The heavy logic (validateHookDef, parseHookDefs, matchHooks, buildHookEnv, contextFromPayload,
 * buildHookPlan, runHookPlan, dispatchHooks, formatHookResult/List, installShellHooks) is PURE over
 * injected inputs. The command runner, approver and clock are all injected stubs — NO real process is
 * ever spawned. A real in-memory SQLite Db is created to prove the module composes with the DB layer
 * without touching it.
 *
 * HONESTY: these tests exercise the pure parse/match/plan/format paths and the approval-gating +
 * command-dispatch paths against injected stubs. Real shell execution against the host OS (the thin
 * defaultHookRunner) is NOT exercised here.
 */
import { describe, it, expect } from 'vitest';
import {
  validateHookDef,
  parseHookDefs,
  matchHooks,
  isHooksEvent,
  buildHookEnv,
  contextFromPayload,
  buildHookPlan,
  buildHookApprovalRequest,
  runHookPlan,
  dispatchHooks,
  installShellHooks,
  formatHookResult,
  formatHookList,
  HOOKS_EVENTS,
  HookManager,
  Db,
  type HookDefinition,
  type HookCommandRunner,
  type HookApprover,
  type HookDispatchDeps,
  type HookRunResult,
} from '../packages/core/src/index.js';

// ── fixtures ───────────────────────────────────────────────────────────────
const fixedClock = () => 1_700_000_000_000;
const okRunner: HookCommandRunner = () => ({ code: 0, stdout: 'done', stderr: '' });
const failRunner: HookCommandRunner = () => ({ code: 3, stdout: '', stderr: 'boom' });
const throwRunner: HookCommandRunner = () => {
  throw new Error('spawn failed');
};
const approve: HookApprover = async () => true;
const deny: HookApprover = async () => false;

const shellEntry = (over: Record<string, unknown> = {}) => ({
  type: 'shell',
  name: 'notify',
  event: 'run_end',
  command: 'echo hi',
  ...over,
});

function makeDeps(over: Partial<HookDispatchDeps> = {}): HookDispatchDeps {
  return { runner: okRunner, approver: approve, clock: fixedClock, ...over };
}

// ── validate / parse ───────────────────────────────────────────────────────────────
describe('validateHookDef', () => {
  it('accepts a well-formed shell hook and applies defaults', () => {
    const v = validateHookDef(shellEntry());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.def).toEqual({ name: 'notify', event: 'run_end', command: 'echo hi', enabled: true, requiresApproval: true });
    }
  });

  it('honors enabled:false and requiresApproval:false', () => {
    const v = validateHookDef(shellEntry({ enabled: false, requiresApproval: false }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.def).toMatchObject({ enabled: false, requiresApproval: false });
  });

  it('accepts the "*" wildcard event', () => {
    const v = validateHookDef(shellEntry({ event: '*' }));
    expect(v.ok).toBe(true);
  });

  it('rejects a non-shell entry', () => {
    const v = validateHookDef({ type: 'log', event: 'run_end' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toContain('not a shell hook');
  });

  it('collects every missing-field error at once', () => {
    const v = validateHookDef({ type: 'shell' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors).toContain('name is required');
      expect(v.errors).toContain('event is required');
      expect(v.errors).toContain('command is required');
    }
  });

  it('rejects an unknown event name', () => {
    const v = validateHookDef(shellEntry({ event: 'not_an_event' }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toContain('unknown event');
  });

  it('rejects a non-object entry', () => {
    const v = validateHookDef('nope');
    expect(v.ok).toBe(false);
  });
});

describe('parseHookDefs', () => {
  it('returns only shell entries, skipping log/webhook', () => {
    const defs = parseHookDefs([
      shellEntry(),
      { type: 'log', event: 'run_start' },
      { type: 'webhook', event: 'run_end', url: 'https://x' },
      shellEntry({ name: 'second', event: 'before_tool_call' }),
    ]);
    expect(defs.map((d) => d.name)).toEqual(['notify', 'second']);
  });

  it('throws on a malformed shell entry', () => {
    expect(() => parseHookDefs([shellEntry({ command: '' })])).toThrow(/invalid shell hook/);
  });

  it('tolerates undefined / empty input', () => {
    expect(parseHookDefs(undefined)).toEqual([]);
    expect(parseHookDefs([])).toEqual([]);
  });
});

describe('isHooksEvent', () => {
  it('recognizes real lifecycle events and rejects junk', () => {
    expect(isHooksEvent('run_end')).toBe(true);
    expect(isHooksEvent('before_tool_call')).toBe(true);
    expect(isHooksEvent('nope')).toBe(false);
    expect(HOOKS_EVENTS.length).toBeGreaterThan(0);
  });
});

// ── matching ───────────────────────────────────────────────────────────────
describe('matchHooks', () => {
  const defs: HookDefinition[] = [
    { name: 'a', event: 'run_end', command: 'c', enabled: true, requiresApproval: true },
    { name: 'b', event: 'run_start', command: 'c', enabled: true, requiresApproval: true },
    { name: 'c', event: '*', command: 'c', enabled: true, requiresApproval: true },
    { name: 'd', event: 'run_end', command: 'c', enabled: false, requiresApproval: true },
  ];

  it('matches exact event plus wildcard, excluding disabled and other events', () => {
    expect(matchHooks('run_end', defs).map((d) => d.name)).toEqual(['a', 'c']);
    expect(matchHooks('run_start', defs).map((d) => d.name)).toEqual(['b', 'c']);
  });

  it('returns empty when nothing matches', () => {
    expect(matchHooks('memory_write', defs).map((d) => d.name)).toEqual(['c']);
    expect(matchHooks('memory_write', [defs[0]!])).toEqual([]);
  });
});

// ── env / context / plan ───────────────────────────────────────────────────────────────
describe('buildHookEnv', () => {
  it('always sets event + ts and includes only defined context fields', () => {
    const env = buildHookEnv('before_tool_call', { runId: 'r1', tool: 'bash' }, fixedClock);
    expect(env.MERCURY_HOOK_EVENT).toBe('before_tool_call');
    expect(env.MERCURY_HOOK_TS).toBe(String(fixedClock()));
    expect(env.MERCURY_RUN_ID).toBe('r1');
    expect(env.MERCURY_TOOL).toBe('bash');
    expect(env.MERCURY_SESSION_ID).toBeUndefined();
    expect(env.MERCURY_USER_ID).toBeUndefined();
  });

  it('omits empty-string values', () => {
    const env = buildHookEnv('run_end', { runId: '', userId: 'u1' }, fixedClock);
    expect(env.MERCURY_RUN_ID).toBeUndefined();
    expect(env.MERCURY_USER_ID).toBe('u1');
  });
});

describe('contextFromPayload', () => {
  it('extracts ids and derives userId/platform from principal', () => {
    const ctx = contextFromPayload({ runId: 'r', sessionId: 's', principal: { userId: 'alice', platform: 'cli' }, tool: 't' });
    expect(ctx).toEqual({ runId: 'r', sessionId: 's', userId: 'alice', tool: 't', model: undefined, status: undefined, platform: 'cli' });
  });

  it('prefers an explicit userId over principal.userId', () => {
    const ctx = contextFromPayload({ userId: 'bob', principal: { userId: 'alice' } });
    expect(ctx.userId).toBe('bob');
  });

  it('ignores non-string fields', () => {
    const ctx = contextFromPayload({ runId: 42, status: 'error' });
    expect(ctx.runId).toBeUndefined();
    expect(ctx.status).toBe('error');
  });
});

describe('buildHookPlan + buildHookApprovalRequest', () => {
  const def: HookDefinition = { name: 'p', event: 'run_end', command: 'echo $MERCURY_STATUS', enabled: true, requiresApproval: true };

  it('builds a plan carrying the resolved env and gating flag', () => {
    const plan = buildHookPlan(def, 'run_end', { runId: 'r9', status: 'ok' }, fixedClock);
    expect(plan).toMatchObject({ name: 'p', event: 'run_end', command: 'echo $MERCURY_STATUS', requiresApproval: true });
    expect(plan.env.MERCURY_RUN_ID).toBe('r9');
    expect(plan.env.MERCURY_STATUS).toBe('ok');
  });

  it('builds a dangerous approval request tagged to the hooks tool', () => {
    const plan = buildHookPlan(def, 'run_end', {}, fixedClock);
    const req = buildHookApprovalRequest(plan);
    expect(req.risk).toBe('dangerous');
    expect(req.tool).toBe('hooks');
    expect(req.detail).toContain('run_end');
    expect(req.detail).toContain('echo $MERCURY_STATUS');
  });
});

// ── runHookPlan: approval gating + runner invocation ───────────────────────────────
describe('runHookPlan', () => {
  const def: HookDefinition = { name: 'run', event: 'run_end', command: 'echo hi', enabled: true, requiresApproval: true };

  it('approved: invokes the runner with the built env and reports ok', async () => {
    let seenCmd = '';
    let seenEnv: Record<string, string> = {};
    const runner: HookCommandRunner = (cmd, opts) => {
      seenCmd = cmd;
      seenEnv = opts.env;
      return { code: 0, stdout: 'out', stderr: '' };
    };
    const plan = buildHookPlan(def, 'run_end', { runId: 'rX', userId: 'u', status: 'ok' }, fixedClock);
    const res = await runHookPlan(plan, makeDeps({ runner }));
    expect(res.status).toBe('ok');
    expect(res.approved).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('out');
    expect(seenCmd).toBe('echo hi');
    expect(seenEnv.MERCURY_RUN_ID).toBe('rX');
    expect(seenEnv.MERCURY_STATUS).toBe('ok');
  });

  it('denied: never invokes the runner and reports denied', async () => {
    let called = false;
    const runner: HookCommandRunner = () => {
      called = true;
      return { code: 0, stdout: '', stderr: '' };
    };
    const plan = buildHookPlan(def, 'run_end', {}, fixedClock);
    const res = await runHookPlan(plan, makeDeps({ runner, approver: deny }));
    expect(res.status).toBe('denied');
    expect(res.approved).toBe(false);
    expect(called).toBe(false);
  });

  it('requiresApproval:false bypasses the approver entirely', async () => {
    let approverCalled = false;
    const approver: HookApprover = async () => {
      approverCalled = true;
      return false;
    };
    const plan = buildHookPlan(
      { ...def, requiresApproval: false },
      'run_end',
      {},
      fixedClock,
    );
    const res = await runHookPlan(plan, makeDeps({ approver }));
    expect(approverCalled).toBe(false);
    expect(res.status).toBe('ok');
  });

  it('non-zero exit code is reported as failed', async () => {
    const plan = buildHookPlan(def, 'run_end', {}, fixedClock);
    const res = await runHookPlan(plan, makeDeps({ runner: failRunner }));
    expect(res.status).toBe('failed');
    expect(res.code).toBe(3);
    expect(res.stderr).toBe('boom');
  });

  it('a throwing runner is captured as error (never propagates)', async () => {
    const plan = buildHookPlan(def, 'run_end', {}, fixedClock);
    const res = await runHookPlan(plan, makeDeps({ runner: throwRunner }));
    expect(res.status).toBe('error');
    expect(res.error).toContain('spawn failed');
  });

  it('passes approval meta derived from env with sensible fallbacks', async () => {
    let meta: { runId?: string; userId: string; platform: string } | undefined;
    const approver: HookApprover = async (_req, m) => {
      meta = m;
      return true;
    };
    const plan = buildHookPlan(def, 'run_end', {}, fixedClock);
    await runHookPlan(plan, makeDeps({ approver, defaultUserId: 'sys', defaultPlatform: 'hooks' }));
    expect(meta).toEqual({ runId: undefined, userId: 'sys', platform: 'hooks' });
  });
});

// ── dispatchHooks ───────────────────────────────────────────────────────────────
describe('dispatchHooks', () => {
  const defs: HookDefinition[] = [
    { name: 'a', event: 'run_end', command: 'c1', enabled: true, requiresApproval: false },
    { name: 'b', event: '*', command: 'c2', enabled: true, requiresApproval: false },
    { name: 'c', event: 'run_start', command: 'c3', enabled: true, requiresApproval: false },
  ];

  it('runs every matching hook and returns one result each', async () => {
    const results = await dispatchHooks('run_end', defs, { runId: 'r' }, makeDeps());
    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('returns empty when nothing matches', async () => {
    const results = await dispatchHooks('memory_write', [defs[0]!], {}, makeDeps());
    expect(results).toEqual([]);
  });
});

// ── installShellHooks (HookManager wiring) ───────────────────────────────────────────
describe('installShellHooks', () => {
  it('fires matching hooks when the real HookManager emits the event', async () => {
    const hm = new HookManager();
    const seen: HookRunResult[] = [];
    const defs = parseHookDefs([shellEntry({ requiresApproval: false })]);
    installShellHooks(hm, defs, makeDeps(), (rs) => seen.push(...rs));
    await hm.run('run_end', { runId: 'r5', status: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'notify', event: 'run_end', status: 'ok' });
  });

  it('does not fire on an unrelated event', async () => {
    const hm = new HookManager();
    const seen: HookRunResult[] = [];
    installShellHooks(hm, parseHookDefs([shellEntry({ requiresApproval: false })]), makeDeps(), (rs) => seen.push(...rs));
    await hm.run('run_start', {});
    expect(seen).toHaveLength(0);
  });

  it('registers no handlers when there are no enabled hooks', () => {
    const hm = new HookManager();
    installShellHooks(hm, parseHookDefs([shellEntry({ enabled: false })]), makeDeps());
    expect(hm.list()).toEqual([]);
  });

  it('a wildcard hook registers on every lifecycle event', () => {
    const hm = new HookManager();
    installShellHooks(hm, parseHookDefs([shellEntry({ event: '*', requiresApproval: false })]), makeDeps());
    expect(hm.list().length).toBe(HOOKS_EVENTS.length);
  });
});

// ── formatting ───────────────────────────────────────────────────────────────
describe('formatting', () => {
  it('formatHookResult renders each status', () => {
    expect(formatHookResult({ name: 'a', event: 'run_end', status: 'ok', approved: true, code: 0, durationMs: 5 })).toContain('✅');
    expect(formatHookResult({ name: 'a', event: 'run_end', status: 'denied', approved: false, durationMs: 0 })).toContain('denied');
    expect(formatHookResult({ name: 'a', event: 'run_end', status: 'error', approved: true, durationMs: 0, error: 'x' })).toContain('error');
    expect(formatHookResult({ name: 'a', event: 'run_end', status: 'failed', approved: true, code: 2, durationMs: 1 })).toContain('exit 2');
  });

  it('formatHookList renders a table or an empty note', () => {
    expect(formatHookList([])).toContain('no shell hooks');
    const table = formatHookList([{ name: 'notify', event: 'run_end', command: 'echo hi', enabled: true, requiresApproval: false }]);
    expect(table).toContain('NAME');
    expect(table).toContain('notify');
    expect(table).toContain('run_end');
  });
});

// ── composes with the DB layer without touching it ─────────────────────────────────
describe('db interoperability', () => {
  it('an in-memory Db coexists with hook dispatch', async () => {
    const db = new Db(':memory:');
    const results = await dispatchHooks('run_end', parseHookDefs([shellEntry({ requiresApproval: false })]), {}, makeDeps());
    expect(results[0]?.status).toBe('ok');
    expect(db).toBeTruthy();
    db.close();
  });
});
