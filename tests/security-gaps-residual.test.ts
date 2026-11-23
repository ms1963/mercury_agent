/**
 * Regression tests for the residual findings closed on the `gaps` branch:
 *  R7 — auxiliary (system-principal) LLM calls made on behalf of a user are checked against and
 *       charged to that user's budget; security decisions stay exempt.
 *  R8 — JSON-schema tools (no zod schema) enforce additionalProperties:false and numeric/string bounds,
 *       also after a before_tool_call hook rewrites the arguments.
 *  R9 — tools that ignore their abort signal are tracked as runaway and further calls are refused.
 *  SC-12 — execute_code can run in a locked-down docker container (stdio tool-call framing).
 *  DD-01 — opt-in automatic critic verification of completed top-level runs.
 *  SC-24 — generic nginx example instead of a host-specific config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTopLevelTypes, ConfigSchema, currentBudgetOwner, SYSTEM_PRINCIPAL, ToolExecutor, withBudgetOwner } from '@mercury/core';
import { dockerCodeArgv, executeCode, resolveExecuteCodeBackend } from '@mercury/tools';
import { directToolContext } from '@mercury/runtime';
import { makeMercury } from './helpers.js';

describe('R7 auxiliary calls are charged to the user they run for', () => {
  it('withBudgetOwner carries a user principal but never the system principal', async () => {
    const user = { kind: 'user', userId: 'u1', username: 'eve', role: 'user' } as never;
    expect(currentBudgetOwner()).toBeUndefined();
    await withBudgetOwner(user, async () => {
      await Promise.resolve();
      expect(currentBudgetOwner()).toBe(user);
    });
    withBudgetOwner(SYSTEM_PRINCIPAL, () => expect(currentBudgetOwner()).toBeUndefined());
  });

  it("a system call inside a user's context hits the user's default budget and is recorded to the user", async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      // Outside any user context the system call is not covered by the '*' rule.
      ctx.m.budgets.setBudget({ user: '*', model: '*', period: 'daily', maxTokens: 5 } as never);
      await expect(ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'hello there' }], { budgetOverride: true })).resolves.toBeTruthy();
      // On behalf of eve it is checked against eve's budget...
      await expect(
        withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'hello there' }], { budgetOverride: true })),
      ).rejects.toThrow(/budget exceeded/);
      // ...but a security decision is never blocked by the user's budget.
      await expect(
        withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'decide' }], { budgetOverride: true, kind: 'decision' })),
      ).resolves.toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  it('usage of an auxiliary call made for a user lands on that user', async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      await withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'summarise' }]));
      const rows = ctx.m.db.all<{ user_id: string; kind: string }>('SELECT user_id, kind FROM usage');
      expect(rows).toContainEqual({ user_id: eve.userId, kind: 'auxiliary' });
      expect(rows.some((r) => r.user_id === 'system')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("an agent run's own budget check still fails for an exhausted user (end to end)", async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      ctx.m.budgets.setBudget({ user: 'eve', model: '*', period: 'daily', maxTokens: 5 } as never);
      const r = await ctx.m.agent.run({ principal: eve, input: 'hello', platform: 'test', ephemeral: true, reflect: false }).catch((e: Error) => ({ status: 'error', error: e.message }));
      expect(JSON.stringify(r)).toMatch(/budget/i);
    } finally {
      await ctx.close();
    }
  });
});

describe('R8 JSON-schema argument enforcement', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'number', minimum: 0, maximum: 10 }, s: { type: 'string', maxLength: 3 }, l: { type: 'array', maxItems: 2 } },
    required: ['n'],
    additionalProperties: false,
  } as never;
  it('rejects out-of-range numbers (also numeric strings), long strings, long arrays and unknown keys', () => {
    expect(checkTopLevelTypes(schema, { n: 999 })).toEqual(['n: must be <= 10']);
    expect(checkTopLevelTypes(schema, { n: '-1' })).toEqual(['n: must be >= 0']);
    expect(checkTopLevelTypes(schema, { n: 1, s: 'abcd' })[0]).toMatch(/at most 3/);
    expect(checkTopLevelTypes(schema, { n: 1, l: [1, 2, 3] })[0]).toMatch(/at most 2 items/);
    expect(checkTopLevelTypes(schema, { n: 1, injected: 'x' })).toEqual(['unknown argument(s): injected']);
    expect(checkTopLevelTypes(schema, { n: 5, s: 'ab', l: [1] })).toEqual([]);
  });
  it('allows unknown keys when the schema does not forbid them', () => {
    expect(checkTopLevelTypes({ type: 'object', properties: { n: { type: 'number' } } } as never, { n: 1, extra: true })).toEqual([]);
  });

  describe('through the executor', () => {
    let ctx: Awaited<ReturnType<typeof makeMercury>>;
    let seen: unknown;
    beforeAll(async () => {
      ctx = await makeMercury();
      ctx.m.users.register('root', 'password-123');
      ctx.m.tools.register({
        name: 'probe_r8', description: 'probe', toolset: 'core', risk: 'safe',
        parameters: { type: 'object', properties: { n: { type: 'number', maximum: 10 } }, required: ['n'], additionalProperties: false },
        execute: async (a: unknown) => { seen = a; return { content: 'ok' }; },
      } as never);
    });
    afterAll(() => ctx.close());
    const exec = (args: Record<string, unknown>) => {
      const eve = ctx.m.users.principalFor(ctx.m.users.findByUsername('root')!);
      return ctx.m.executor.execute({ id: `c${Math.random()}`, name: 'probe_r8', arguments: args } as never, directToolContext(ctx.m, eve, 'r8'), { untrustedSeen: false, userRequest: 't' } as never);
    };
    it('direct out-of-range args are refused before execution', async () => {
      seen = undefined;
      const r = await exec({ n: 999 });
      expect(r.ok).toBe(false);
      expect(r.result.content).toMatch(/must be <= 10/);
      expect(seen).toBeUndefined();
    });
    it('hook-rewritten args with extra keys are refused', async () => {
      seen = undefined;
      ctx.m.hooks.register('before_tool_call', 'r8test', async (p: { tool?: string }) => (p.tool === 'probe_r8' ? { args: { n: 1, injected: 'x' } } : {}));
      const r = await exec({ n: 2 });
      expect(r.ok).toBe(false);
      expect(r.result.content).toMatch(/Hook produced invalid arguments.*unknown argument/);
      expect(seen).toBeUndefined();
    });
  });
});

describe('SC-12 execute_code backends', () => {
  it("'auto' follows the terminal backend; explicit values win", () => {
    const cfg = (o: Record<string, unknown>) => ConfigSchema.parse({ tools: o });
    expect(resolveExecuteCodeBackend(cfg({}))).toBe('host');
    expect(resolveExecuteCodeBackend(cfg({ terminal: { backend: 'docker' } }))).toBe('docker');
    expect(resolveExecuteCodeBackend(cfg({ terminal: { backend: 'docker' }, executeCode: { backend: 'host' } }))).toBe('host');
    expect(resolveExecuteCodeBackend(cfg({ executeCode: { backend: 'docker' } }))).toBe('docker');
  });
  it('the docker invocation has no network, no capabilities, read-only fs and code mount, unprivileged user', () => {
    const argv = dockerCodeArgv(ConfigSchema.parse({}), 'python', '/tmp/x', 'n1').join(' ');
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 65534:65534', '-v /tmp/x:/code:ro', '--pids-limit', '--memory'])
      expect(argv).toContain(flag);
    expect(argv).toContain('python:3.12-slim python3 -u /code/main.py');
    expect(dockerCodeArgv(ConfigSchema.parse({}), 'javascript', '/tmp/x', 'n1').join(' ')).toContain('node:22-slim node /code/main.mjs');
  });

  describe('stdio tool-call framing (the protocol used inside docker), exercised on the host', () => {
    let ctx: Awaited<ReturnType<typeof makeMercury>>;
    beforeAll(async () => {
      ctx = await makeMercury({}, { startServices: true });
    });
    afterAll(() => ctx.close());
    const run = async (language: 'python' | 'javascript', code: string) =>
      executeCode(directToolContext(ctx.m, await ctx.m.localPrincipal(), 'cli'), language, code, { backend: 'host', transport: 'stdio' });
    it('python: tool calls work and ordinary stderr is kept separate', async () => {
      const r = await run('python', ['import sys', 'sys.stderr.write("diag\\n")', 'print("a=" + call_tool("calculator", expression="6*7"))', 'print("b=" + call_tool("calculator", expression="1+1"))'].join('\n'));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/a=.*42/);
      expect(r.stdout).toMatch(/b=.*2/);
      expect(r.toolCalls).toBe(2);
      expect(r.stderr).toContain('diag');
      expect(r.stderr).not.toContain('MRPC');
    });
    it('javascript: tool calls work and the script exits', async () => {
      const r = await run('javascript', 'console.log("x=" + await callTool("calculator", { expression: "3*3" })); console.log("y=" + await callTool("calculator", { expression: "2+2" }));');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/x=.*9/);
      expect(r.stdout).toMatch(/y=.*4/);
    });
    it('blocked tools stay blocked over the stdio channel', async () => {
      const r = await run('python', ['try:', '    call_tool("execute_code", code="1")', 'except RuntimeError as e:', '    print("blocked:", e)'].join('\n'));
      expect(r.stdout).toContain('cannot be called from execute_code');
    });
  });
});

describe('DD-01 automatic verification of completed runs', () => {
  it('is off by default', async () => {
    const ctx = await makeMercury();
    try {
      const p = await ctx.m.localPrincipal();
      await ctx.m.agent.run({ principal: p, input: 'hello', platform: 'test' });
      await ctx.m.verificationIdle();
      expect(ctx.m.db.all('SELECT id FROM verifications')).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
  it('verification.autoVerify records a critic verification per top-level run and escalates failures', async () => {
    const ctx = await makeMercury({ verification: { autoVerify: true } });
    try {
      ctx.m.verifier.setCritic(async () => ({ passed: false, confidence: 0.1, detail: 'test critic' }));
      const p = await ctx.m.localPrincipal();
      const r = await ctx.m.agent.run({ principal: p, input: 'hello', platform: 'test' });
      await ctx.m.verificationIdle();
      const rows = ctx.m.db.all<{ run_id: string; passed: number; escalated: number }>('SELECT run_id, passed, escalated FROM verifications');
      expect(rows).toEqual([{ run_id: r.runId, passed: 0, escalated: 1 }]);
      expect(ctx.m.db.all('SELECT id FROM escalations WHERE run_id = ?', r.runId)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});

describe('SC-24 no host-specific deployment artefacts', () => {
  it('ships a generic nginx example instead of a host-specific config', () => {
    const root = join(__dirname, '..');
    expect(existsSync(join(root, 'deploy', '14444ce25a.conf'))).toBe(false);
    const conf = readFileSync(join(root, 'deploy', 'nginx.conf.example'), 'utf8');
    expect(conf).not.toMatch(/14444ce25a|abacusai|x_original_host/);
    expect(conf).not.toMatch(/s-maxage|proxy_cache\s/);
  });
});

describe('R9 runaway tools that ignore cancellation', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  const release: Array<() => void> = [];
  let started = 0;
  beforeAll(async () => {
    ctx = await makeMercury();
    ctx.m.users.register('root', 'password-123');
    ctx.m.tools.register({
      name: 'stubborn', description: 'ignores abort', toolset: 'core', risk: 'safe', timeoutMs: 20,
      parameters: { type: 'object', properties: {} },
      execute: () => { started++; return new Promise((r) => release.push(() => r({ content: 'late' }))); },
    } as never);
    ctx.m.tools.register({
      name: 'polite', description: 'honours abort', toolset: 'core', risk: 'safe', timeoutMs: 20,
      parameters: { type: 'object', properties: {} },
      execute: (_a: unknown, c: { signal?: AbortSignal }) => new Promise((_r, rej) => c.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    } as never);
  });
  afterAll(() => ctx.close());
  const exec = (name: string) => {
    const root = ctx.m.users.principalFor(ctx.m.users.findByUsername('root')!);
    return ctx.m.executor.execute({ id: `c${Math.random()}`, name, arguments: {} } as never, directToolContext(ctx.m, root, 'r9'), { untrustedSeen: false, userRequest: 't' } as never);
  };

  it('a tool that honours abort is not counted as runaway', async () => {
    const r = await exec('polite');
    expect(r.ok).toBe(false);
    await new Promise((r2) => setTimeout(r2, 5));
    expect(ctx.m.executor.runawayCount('polite')).toBe(0);
  });

  it('timed-out executions that keep running are tracked, emitted and block further calls at the limit', async () => {
    const events: unknown[] = [];
    ctx.m.bus.on('tool.runaway', (e: unknown) => events.push(e));
    for (let i = 0; i < ToolExecutor.MAX_RUNAWAY_PER_TOOL; i++) {
      const r = await exec('stubborn');
      expect(r.result.content).toMatch(/timed out/);
    }
    expect(ctx.m.executor.runawayCount('stubborn')).toBe(ToolExecutor.MAX_RUNAWAY_PER_TOOL);
    expect(events.length).toBe(ToolExecutor.MAX_RUNAWAY_PER_TOOL);
    const before = started;
    const blocked = await exec('stubborn');
    expect(blocked.ok).toBe(false);
    expect(blocked.result.content).toMatch(/still running past their timeout/);
    expect(started).toBe(before); // never invoked
  });

  it('once the runaway executions settle, the tool is usable again', async () => {
    release.splice(0).forEach((f) => f());
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.m.executor.runawayCount('stubborn')).toBe(0);
    const p = exec('stubborn');
    expect((await p).result.content).toMatch(/timed out/);
    release.splice(0).forEach((f) => f());
  });
});
