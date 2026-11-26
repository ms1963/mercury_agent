/**
 * Shell hooks — run a user-configured shell command at a real lifecycle event.
 *
 * Hooks are declared in config (`hooks:` array, `type: shell`) and bound to one of the
 * curated lifecycle events in {@link HOOKS_EVENTS} (the same points the plugin HookManager
 * fires: run start/end, tool calls, memory writes, …). Every hook that shells out is routed
 * through the approvals layer BEFORE the command is spawned, consistent with every other
 * shell-out in the codebase.
 *
 * This module is split into:
 *   - PURE functions (parse/validate, event matching, env + plan building, result formatting)
 *     which take an injected command runner, approver and clock so they are unit-testable with
 *     no real process spawning; and
 *   - a thin IO layer ({@link defaultHookRunner}) that actually spawns via node:child_process.
 *
 * Exported type names are prefixed `Hook`/`Hooks` to avoid barrel-export collisions.
 */
import { spawnSync } from 'node:child_process';

import type { ApprovalRequest } from '../tools/types.js';
import { HOOK_NAMES, type HookManager, type HookName } from '../plugins/hooks.js';

/** Lifecycle events a shell hook may bind to (the real HookManager interception points). */
export const HOOKS_EVENTS: readonly HookName[] = HOOK_NAMES;
/** A single lifecycle event name a shell hook can bind to. */
export type HooksEventName = HookName;

/** A validated shell-hook definition (the `type: shell` view of a config `hooks` entry). */
export interface HookDefinition {
  name: string;
  /** Lifecycle event, or `*` to fire on every lifecycle event. */
  event: HooksEventName | '*';
  command: string;
  enabled: boolean;
  requiresApproval: boolean;
}

/** Raw config `hooks[]` entry shape (shell + the legacy log/webhook variants share the array). */
export interface HookConfigEntry {
  event: string;
  type?: string;
  url?: string;
  name?: string;
  command?: string;
  enabled?: boolean;
  requiresApproval?: boolean;
}

/** Context captured from a fired lifecycle event, surfaced to the hook command as env vars. */
export interface HookContext {
  runId?: string;
  sessionId?: string;
  userId?: string;
  tool?: string;
  model?: string;
  status?: string;
  platform?: string;
}

/** A ready-to-run hook: the command plus the resolved environment and gating decision. */
export interface HookExecPlan {
  name: string;
  event: HooksEventName;
  command: string;
  env: Record<string, string>;
  requiresApproval: boolean;
}

export type HookRunStatus = 'ok' | 'failed' | 'denied' | 'error';

/** The outcome of running one hook. */
export interface HookRunResult {
  name: string;
  event: HooksEventName;
  status: HookRunStatus;
  approved: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  error?: string;
}

/** Normalized output of the (injected) command runner. */
export interface HookCommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HookRunnerOptions {
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/** Injected command runner — the pure layer never spawns directly. */
export type HookCommandRunner = (command: string, opts: HookRunnerOptions) => HookCommandOutput | Promise<HookCommandOutput>;

/** Injected approvals gate. Returns `true` when the command may run. */
export type HookApprover = (req: ApprovalRequest, meta: { runId?: string; userId: string; platform: string }) => Promise<boolean>;

/** Injected clock (ms epoch) so timing is deterministic in tests. */
export type HookClock = () => number;

export interface HookDispatchDeps {
  runner: HookCommandRunner;
  approver: HookApprover;
  clock?: HookClock;
  cwd?: string;
  timeoutMs?: number;
  /** Fallbacks when the lifecycle context omits them (e.g. system user / platform). */
  defaultUserId?: string;
  defaultPlatform?: string;
}

/** Validation result for a single raw hook entry. */
export type HookValidation = { ok: true; def: HookDefinition } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** True when `name` is a supported lifecycle event (or the `*` wildcard). */
export function isHooksEvent(name: string): name is HooksEventName {
  return (HOOKS_EVENTS as readonly string[]).includes(name);
}

/**
 * Validate and normalize a single raw config entry into a shell {@link HookDefinition}.
 * Only `type: shell` entries are shell hooks; anything else is reported as not-a-shell-hook.
 */
export function validateHookDef(raw: unknown): HookValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['hook entry must be an object'] };
  if (raw.type !== 'shell') return { ok: false, errors: [`not a shell hook (type=${String(raw.type ?? 'log')})`] };

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const event = typeof raw.event === 'string' ? raw.event.trim() : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!name) errors.push('name is required');
  if (!event) errors.push('event is required');
  else if (event !== '*' && !isHooksEvent(event)) errors.push(`unknown event "${event}" (see: mercury hooks events)`);
  if (!command) errors.push('command is required');
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    def: {
      name,
      event: event as HooksEventName | '*',
      command,
      enabled: raw.enabled !== false,
      requiresApproval: raw.requiresApproval !== false,
    },
  };
}

/**
 * Parse a config `hooks[]` array into validated shell-hook definitions. Non-shell entries
 * (log/webhook) are skipped. Throws if a shell entry is malformed (fail loud at load).
 */
export function parseHookDefs(rawHooks: readonly unknown[] | undefined): HookDefinition[] {
  const defs: HookDefinition[] = [];
  for (const raw of rawHooks ?? []) {
    if (!isRecord(raw) || raw.type !== 'shell') continue;
    const v = validateHookDef(raw);
    if (!v.ok) throw new Error(`invalid shell hook: ${v.errors.join('; ')}`);
    defs.push(v.def);
  }
  return defs;
}

/** All enabled hooks bound to `event` (or to the `*` wildcard). */
export function matchHooks(event: HooksEventName, defs: readonly HookDefinition[]): HookDefinition[] {
  return defs.filter((d) => d.enabled && (d.event === event || d.event === '*'));
}

/**
 * Build the environment passed to a hook command from the fired event + context. Every value
 * is a string; only defined fields are included. Prefixed `MERCURY_` so hook scripts have a
 * stable contract.
 */
export function buildHookEnv(event: HooksEventName, ctx: HookContext, clock: HookClock = Date.now): Record<string, string> {
  const env: Record<string, string> = { MERCURY_HOOK_EVENT: event, MERCURY_HOOK_TS: String(clock()) };
  const add = (key: string, v: string | undefined): void => {
    if (v !== undefined && v !== '') env[key] = v;
  };
  add('MERCURY_RUN_ID', ctx.runId);
  add('MERCURY_SESSION_ID', ctx.sessionId);
  add('MERCURY_USER_ID', ctx.userId);
  add('MERCURY_TOOL', ctx.tool);
  add('MERCURY_MODEL', ctx.model);
  add('MERCURY_STATUS', ctx.status);
  add('MERCURY_PLATFORM', ctx.platform);
  return env;
}

/** Derive a {@link HookContext} from a loosely-typed lifecycle payload (HookManager/EventBus). */
export function contextFromPayload(payload: Record<string, unknown>): HookContext {
  const principal = isRecord(payload.principal) ? payload.principal : undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    runId: str(payload.runId),
    sessionId: str(payload.sessionId),
    userId: str(payload.userId) ?? (principal ? str(principal.userId) : undefined),
    tool: str(payload.tool),
    model: str(payload.model),
    status: str(payload.status),
    platform: str(payload.platform) ?? (principal ? str(principal.platform) : undefined),
  };
}

/** Build the ready-to-run plan for a single hook. */
export function buildHookPlan(def: HookDefinition, event: HooksEventName, ctx: HookContext, clock: HookClock = Date.now): HookExecPlan {
  return {
    name: def.name,
    event,
    command: def.command,
    env: buildHookEnv(event, ctx, clock),
    requiresApproval: def.requiresApproval,
  };
}

/** Build the approval request shown to the user before a hook command is spawned. */
export function buildHookApprovalRequest(plan: HookExecPlan): ApprovalRequest {
  return {
    title: `Run shell hook "${plan.name}"`,
    detail: `Lifecycle event: ${plan.event}\nCommand: ${plan.command}`,
    risk: 'dangerous',
    tool: 'hooks',
    args: { name: plan.name, event: plan.event, command: plan.command },
  };
}

/**
 * Run one hook plan: gate through approvals (if required), then invoke the injected runner.
 * Never throws — failures and denials are captured in the returned {@link HookRunResult}.
 */
export async function runHookPlan(plan: HookExecPlan, deps: HookDispatchDeps): Promise<HookRunResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const base: Pick<HookRunResult, 'name' | 'event'> = { name: plan.name, event: plan.event };

  let approved = true;
  if (plan.requiresApproval) {
    approved = await deps.approver(buildHookApprovalRequest(plan), {
      runId: plan.env.MERCURY_RUN_ID,
      userId: plan.env.MERCURY_USER_ID ?? deps.defaultUserId ?? 'system',
      platform: plan.env.MERCURY_PLATFORM ?? deps.defaultPlatform ?? 'cli',
    });
    if (!approved) {
      return { ...base, status: 'denied', approved: false, durationMs: Math.max(0, clock() - started) };
    }
  }

  try {
    const res = await deps.runner(plan.command, { env: plan.env, cwd: deps.cwd, timeoutMs: deps.timeoutMs });
    return {
      ...base,
      status: res.code === 0 ? 'ok' : 'failed',
      approved,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Math.max(0, clock() - started),
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      approved,
      durationMs: Math.max(0, clock() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Match + run every hook bound to `event`. Hooks run sequentially so approval prompts don't
 * overlap. Returns one result per matched hook (empty array when none match).
 */
export async function dispatchHooks(
  event: HooksEventName,
  defs: readonly HookDefinition[],
  ctx: HookContext,
  deps: HookDispatchDeps,
): Promise<HookRunResult[]> {
  const clock = deps.clock ?? Date.now;
  const matched = matchHooks(event, defs);
  const results: HookRunResult[] = [];
  for (const def of matched) {
    results.push(await runHookPlan(buildHookPlan(def, event, ctx, clock), deps));
  }
  return results;
}

/** One-line summary of a run result for CLI output. */
export function formatHookResult(r: HookRunResult): string {
  const icon = r.status === 'ok' ? '✅' : r.status === 'denied' ? '⛔' : '❌';
  const tail =
    r.status === 'denied'
      ? 'denied by approvals'
      : r.status === 'error'
        ? `error: ${r.error ?? 'unknown'}`
        : `exit ${r.code ?? '?'} (${r.durationMs}ms)`;
  return `${icon} ${r.name} [${r.event}] — ${tail}`;
}

/** Render configured hook definitions as a readable table. */
export function formatHookList(defs: readonly HookDefinition[]): string {
  if (!defs.length) return '(no shell hooks configured)';
  const rows = defs.map((d) => ({
    name: d.name,
    event: d.event,
    enabled: d.enabled ? 'on' : 'off',
    approval: d.requiresApproval ? 'yes' : 'no',
    command: d.command.length > 48 ? `${d.command.slice(0, 47)}…` : d.command,
  }));
  const width = (key: keyof (typeof rows)[number]): number =>
    Math.max(key.length, ...rows.map((r) => r[key].length));
  const w = { name: width('name'), event: width('event'), enabled: Math.max(7, width('enabled')), approval: Math.max(8, width('approval')) };
  const header = `${'NAME'.padEnd(w.name)}  ${'EVENT'.padEnd(w.event)}  ${'ENABLED'.padEnd(w.enabled)}  ${'APPROVAL'.padEnd(w.approval)}  COMMAND`;
  const body = rows
    .map((r) => `${r.name.padEnd(w.name)}  ${r.event.padEnd(w.event)}  ${r.enabled.padEnd(w.enabled)}  ${r.approval.padEnd(w.approval)}  ${r.command}`)
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Thin IO layer: the default runner that actually spawns a shell command. Uses a login-less
 * `sh -c`, inherits the current environment and overlays the hook env, and captures output.
 * Never used by the pure functions directly — callers inject it.
 */
export function defaultHookRunner(command: string, opts: HookRunnerOptions): HookCommandOutput {
  const res = spawnSync(command, {
    shell: true,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 30_000,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    code: typeof res.status === 'number' ? res.status : res.signal ? 1 : 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? res.error.message : ''),
  };
}

/**
 * Wire configured shell hooks into the live {@link HookManager}, so they fire at the real
 * lifecycle points (run start/end, tool calls, memory writes, …). One handler is registered per
 * referenced event; each handler builds the context from the fired payload and dispatches the
 * matching hooks through the injected approver + runner. Handlers never throw.
 */
export function installShellHooks(
  hooks: HookManager,
  defs: readonly HookDefinition[],
  deps: HookDispatchDeps,
  onResults?: (results: HookRunResult[]) => void,
): void {
  const active = defs.filter((d) => d.enabled);
  if (!active.length) return;
  const events: HooksEventName[] = active.some((d) => d.event === '*')
    ? [...HOOKS_EVENTS]
    : [...new Set(active.map((d) => d.event).filter((e): e is HooksEventName => e !== '*'))];
  for (const event of events) {
    hooks.register(
      event,
      `shell-hooks-${event}`,
      async (payload) => {
        const results = await dispatchHooks(event, active, contextFromPayload(payload), deps);
        if (onResults && results.length) onResults(results);
      },
      1000,
    );
  }
}
