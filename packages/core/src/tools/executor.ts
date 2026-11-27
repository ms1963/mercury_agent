/**
 * ToolExecutor — the guarded pipeline every tool call passes through:
 *
 *   lookup → enabled? → RBAC/ABAC → argument validation → approval decision
 *   (risk, per-call rules, untrusted-derived sensitive calls; manual/auto/smart/deny)
 *   → before_tool_call hooks → execute (timeout, abort) → secret redaction
 *   → spotlighting of untrusted output → after_tool_call hooks → audit + events
 */
import type { MercuryConfig } from '../config/schema.js';
import { globMatch, type PolicyEngine } from '../auth/policy.js';
import type { EventBus } from '../events/bus.js';
import type { Judgment } from '../decision/judgment.js';
import type { HookManager } from '../plugins/hooks.js';
import type { AuditLog } from '../security/audit.js';
import type { PolicyCodeEngine } from '../security/policy-code.js';
import type { TaintTracker } from '../security/taint.js';
import type { GrantBroker } from '../auth/grants.js';
import type { ChaosController } from '../reliability/chaos.js';
import { redactSecrets } from '../security/redact.js';
import { scanForInjection, spotlight } from '../security/injection.js';
import { errorMessage, truncate } from '../types/common.js';
import type { JsonSchema, ToolCall } from '../types/messages.js';
import type { ToolRegistry } from './registry.js';
import type { AnyTool, ToolContext, ToolResult } from './types.js';

/** Mutable per-run security state shared across tool calls. */
export interface RunSecurityState {
  /** True once any untrusted content entered the context window. */
  untrustedSeen: boolean;
  /** The authenticated user's request (used by the smart approval gate). */
  userRequest: string;
  /** Sources that tainted this run's context (for the audit trail), newest last. */
  taintedSources?: string[];
}

export interface ExecutedTool {
  call: ToolCall;
  result: ToolResult;
  /** Content to put into the tool message (redacted, spotlighted, truncated). */
  modelContent: string;
  ok: boolean;
  durationMs: number;
}

export class ToolExecutor {
  constructor(
    private config: MercuryConfig,
    private registry: ToolRegistry,
    private policy: PolicyEngine,
    private bus: EventBus,
    private judgment: Judgment | undefined,
    private hooks: HookManager | undefined,
    private audit: AuditLog | undefined,
    /** Policy-as-code engine (declarative rules enforced before sensitive actions). */
    private codePolicies?: PolicyCodeEngine,
    /** Least-privilege grant broker (time-limited scoped capabilities, no standing keys). */
    private grants?: GrantBroker,
    /** Prompt-injection taint tracker (tool outputs marked/propagated per run). */
    private taint?: TaintTracker,
    /** Chaos fault injector (off by default); exercises recovery paths when enabled. */
    private chaos?: ChaosController,
  ) {}

  /**
   * Executions that timed out (or were stopped) but whose promise has not settled because the
   * tool ignores its abort signal. JavaScript cannot force-kill an in-process promise, so these
   * are tracked per tool and further calls are refused while too many are still running.
   */
  private readonly runaway = new Map<string, number>();
  static readonly MAX_RUNAWAY_PER_TOOL = 2;

  /** Per-run memo of smart-gate decisions (coalesces identical gated calls; bounded, oldest-evicted). */
  private readonly gateMemo = new Map<string, Promise<{ approve: boolean; probability: number }>>();
  static readonly GATE_MEMO_MAX = 1000;

  /** Number of still-running executions of `tool` that outlived their timeout/abort. */
  runawayCount(tool: string): number {
    return this.runaway.get(tool) ?? 0;
  }

  async execute(call: ToolCall, ctx: ToolContext, state: RunSecurityState): Promise<ExecutedTool> {
    const started = Date.now();
    const fail = (content: string, kind = 'error'): ExecutedTool => {
      this.bus.emit({ type: kind === 'denied' ? 'tool.denied' : 'tool.result', runId: ctx.runId, data: { id: call.id, name: call.name, ok: false, error: content, durationMs: Date.now() - started } });
      return { call, result: { content, isError: true }, modelContent: `Error: ${content}`, ok: false, durationMs: Date.now() - started };
    };

    const tool = this.registry.get(call.name);
    if (!tool) {
      // Gap signal for self-extending tools: a capability was requested that no registered tool
      // provides. The runtime's gap tracker (when selfExtension is enabled) listens for this to
      // decide, after a threshold of repeats, whether to offer to synthesize a tool. Emitting the
      // event is side-effect-free here — nothing is synthesized or run from inside the executor.
      this.bus.emit({ type: 'tool.miss', runId: ctx.runId, data: { id: call.id, name: call.name } });
      return fail(`Unknown tool "${call.name}". Available tools are listed in your tool definitions.`);
    }
    if (!this.registry.isEnabled(tool, ctx.platform, ctx.allowedToolsets)) return fail(`Tool "${call.name}" is disabled for this agent/platform.`, 'denied');
    const denied = this.policy.check(ctx.principal, 'tool.use', { tool: { name: tool.name, toolset: tool.toolset, risk: tool.risk }, profile: ctx.personality });
    if (denied) return fail(`Permission denied: ${denied}`, 'denied');
    const stuck = this.runawayCount(tool.name);
    if (stuck >= ToolExecutor.MAX_RUNAWAY_PER_TOOL) {
      return fail(`Tool "${tool.name}" has ${stuck} earlier execution(s) still running past their timeout (it ignores cancellation); refusing new calls until they finish.`, 'denied');
    }

    // Validate arguments (schema when declared, else the required list). Returns an error text.
    const validate = (input: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } => {
      if (tool.schema) {
        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) return { error: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        return { args: parsed.data as Record<string, unknown> };
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: `Invalid arguments for ${tool.name}: expected an object` };
      const missing = (tool.parameters.required ?? []).filter((k) => input[k] === undefined);
      if (missing.length) return { error: `Missing required arguments for ${tool.name}: ${missing.join(', ')}` };
      const typeErrors = checkTopLevelTypes(tool.parameters, input);
      if (typeErrors.length) return { error: `Invalid arguments for ${tool.name}: ${typeErrors.join('; ')}` };
      return { args: input };
    };
    const first = validate(call.arguments ?? {});
    if ('error' in first) return fail(first.error);
    let args = first.args;

    this.bus.emit({ type: 'tool.call', runId: ctx.runId, sessionId: ctx.sessionId, data: { id: call.id, name: tool.name, args: redactSecrets(JSON.stringify(args)).text, risk: tool.risk } });

    const approval = await this.approve(tool, args, ctx, state);
    if (!approval.ok) {
      this.audit?.record(ctx.principal.username, 'tool.denied', tool.name, { args, reason: approval.reason });
      return fail(`Tool call not approved: ${approval.reason}. Ask the user how to proceed.`, 'denied');
    }

    const before = await this.hooks?.run('before_tool_call', { tool: tool.name, args, principal: ctx.principal, runId: ctx.runId });
    if (before?.block) return fail(`Blocked by hook: ${String(before.block)}`, 'denied');
    if (before?.args && JSON.stringify(before.args) !== JSON.stringify(args)) {
      // A hook rewrote the arguments: re-validate them and re-run the approval decision on the
      // NEW arguments — the user/gate approved the original call, not the rewritten one.
      const again = validate(before.args as Record<string, unknown>);
      if ('error' in again) return fail(`Hook produced invalid arguments: ${again.error}`);
      args = again.args;
      const reapproval = await this.approve(tool, args, ctx, state);
      if (!reapproval.ok) {
        this.audit?.record(ctx.principal.username, 'tool.denied', tool.name, { args, reason: reapproval.reason, rewrittenByHook: true });
        return fail(`Tool call not approved after hook rewrite: ${reapproval.reason}.`, 'denied');
      }
    }

    // Chaos fault injection (opt-in): deliberately fail/slow eligible tools to exercise recovery.
    const injection = this.chaos?.decide(tool.name) ?? null;
    let result: ToolResult;
    if (injection === 'fail') {
      result = { content: `Chaos fault injection: simulated failure of tool "${tool.name}".`, isError: true };
    } else if (injection === 'timeout') {
      await new Promise((r) => setTimeout(r, this.chaos?.latencyMs ?? 1000));
      result = { content: `Chaos fault injection: simulated timeout of tool "${tool.name}".`, isError: true };
    } else {
      // Per-call abort: a timeout (or run stop) aborts the tool's own signal so child processes,
      // fetches etc. are actually cancelled instead of running on in the background.
      const callCtl = new AbortController();
      const onRunAbort = () => callCtl.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) callCtl.abort(ctx.signal.reason);
      else ctx.signal?.addEventListener('abort', onRunAbort, { once: true });
      let settled = false;
      const pending = Promise.resolve()
        .then(() => tool.execute(args, { ...ctx, signal: callCtl.signal }))
        .finally(() => { settled = true; });
      try {
        const raw = await withTimeout(pending, tool.timeoutMs ?? this.config.agent.toolTimeoutMs, ctx.signal, tool.name, callCtl);
        result = typeof raw === 'string' ? { content: raw } : raw;
      } catch (err) {
        result = { content: errorMessage(err), isError: true };
        if (!settled) {
          // The tool did not honour the abort: track it until its promise finally settles.
          this.runaway.set(tool.name, this.runawayCount(tool.name) + 1);
          this.bus.emit({ type: 'tool.runaway', runId: ctx.runId, data: { id: call.id, name: tool.name, running: this.runawayCount(tool.name) } });
          this.audit?.record(ctx.principal.username, 'tool.runaway', tool.name, { runId: ctx.runId, running: this.runawayCount(tool.name) });
          void pending.then(
            () => this.releaseRunaway(tool.name),
            () => this.releaseRunaway(tool.name),
          );
        }
      } finally {
        ctx.signal?.removeEventListener('abort', onRunAbort);
      }
    }

    const afterHook = await this.hooks?.run('after_tool_call', { tool: tool.name, args, result, runId: ctx.runId });
    if (afterHook?.result) result = afterHook.result as ToolResult;

    let content = this.config.security.redactSecrets ? redactSecrets(result.content).text : result.content;
    content = truncate(content, tool.maxOutputChars ?? 20_000);
    const untrusted = (tool.untrustedOutput || result.untrusted) && !result.isError;
    if (untrusted) {
      state.untrustedSeen = true;
      const source = `tool:${tool.name}`;
      const scan = scanForInjection(content);
      // Taint tracking: record that untrusted content entered this run's context and propagate it.
      const marked = this.taint?.mark(ctx.runId, source, content);
      (state.taintedSources ??= []).push(source);
      this.bus.emit({ type: 'taint.mark', runId: ctx.runId, data: { source, suspicious: marked?.suspicious ?? scan.suspicious, matches: scan.matches } });
      if (scan.suspicious) this.bus.emit({ type: 'guardrail', runId: ctx.runId, data: { layer: 'tool_output', tool: tool.name, injection: scan, blocked: false } });
      content = spotlight(content, source);
    }
    const durationMs = Date.now() - started;
    const ok = !result.isError;
    if (tool.risk !== 'safe') this.audit?.record(ctx.principal.username, 'tool.exec', tool.name, { args, ok, runId: ctx.runId });
    this.bus.emit({ type: 'tool.result', runId: ctx.runId, sessionId: ctx.sessionId, data: { id: call.id, name: tool.name, ok, durationMs, untrusted, preview: content.slice(0, 1000) } });
    return { call: { ...call, arguments: args }, result, modelContent: ok ? content : `Error: ${content}`, ok, durationMs };
  }

  /** Decide whether a call may run, consulting grants, policy-as-code, the smart gate and/or a human. */
  private async approve(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext, state: RunSecurityState): Promise<{ ok: boolean; reason: string }> {
    const taintedCtx = state.untrustedSeen || this.taint?.isTainted(ctx.runId) || false;

    // (1) Least-privilege: a tool declaring a capability must hold a live, scoped grant for the
    // task — the agent holds no standing keys. Absent/expired/revoked grant → hard deny.
    if (tool.capability && this.grants && this.config.security.grants.enabled) {
      const scope = tool.capabilityScope?.(args, ctx);
      if (!this.grants.check(ctx.runId ?? '', tool.capability, scope)) {
        this.audit?.record(ctx.principal.username, 'grant.denied', tool.name, { capability: tool.capability, scope, runId: ctx.runId });
        this.bus.emit({ type: 'grant.denied', runId: ctx.runId, data: { tool: tool.name, capability: tool.capability, scope } });
        return { ok: false, reason: `no valid capability grant for "${tool.capability}"${scope ? ` (scope: ${scope})` : ''}` };
      }
    }

    // (2) Policy-as-code: declarative rules evaluated before the action. `deny` blocks outright;
    // `approve` routes to the gate/human even in auto mode.
    const verdict =
      this.codePolicies && this.config.security.policies.enabled ? this.codePolicies.evaluate(tool.name, args, { tainted: taintedCtx }) : undefined;
    if (verdict?.decision === 'deny') {
      this.audit?.record(ctx.principal.username, 'policy.deny', tool.name, { rule: verdict.rule?.id, reason: verdict.reason, runId: ctx.runId });
      this.bus.emit({ type: 'policy.denied', runId: ctx.runId, data: { tool: tool.name, rule: verdict.rule?.id, reason: verdict.reason } });
      return { ok: false, reason: `blocked by policy${verdict.rule?.id ? ` ${verdict.rule.id}` : ''}: ${verdict.reason}` };
    }

    const reasons: string[] = [];
    // Host-level execution by a non-admin is a privilege boundary: it bypasses the path jail and
    // could read server secrets, so only an admin may approve it (self-approval is not enough).
    const hostGate = !!tool.hostAccess && ctx.principal.role !== 'admin' && this.config.tools.hostAccess.nonAdmin !== 'allow';
    if (hostGate && this.config.tools.hostAccess.nonAdmin === 'deny') return { ok: false, reason: `${tool.name} runs on the host and is disabled for non-admin users (tools.hostAccess.nonAdmin=deny)` };
    if (hostGate) reasons.push(`${tool.name} runs on the host; a non-admin call needs an admin's approval`);
    if (tool.risk === 'dangerous') reasons.push(`${tool.name} is a dangerous tool`);
    const per = tool.needsApproval?.(args, ctx);
    if (per) reasons.push(typeof per === 'string' ? per : `${tool.name} requires approval for these arguments`);
    const untrustedDerived = taintedCtx && !!tool.sensitive;
    if (untrustedDerived) reasons.push('the context contains untrusted content and this tool acts on the outside world');
    const policyApprove = verdict?.decision === 'approve';
    if (policyApprove) {
      reasons.push(`policy${verdict!.rule?.id ? ` ${verdict!.rule.id}` : ''} requires approval: ${verdict!.reason}`);
      this.bus.emit({ type: 'policy.approval', runId: ctx.runId, data: { tool: tool.name, rule: verdict!.rule?.id, reason: verdict!.reason } });
    }
    if (!reasons.length) return { ok: true, reason: 'not required' };

    const mode = this.config.tools.approvals.mode;
    const reason = reasons.join('; ');

    // Memoized/coalesced smart gate: identical gated calls within a run reuse one judgment (an LLM
    // classification). Avoids redundant network round-trips and keeps the decision consistent per run.
    const gate = () => this.gateDecision(tool, args, ctx, state, taintedCtx);

    // Whether a human can realistically answer an approval on this platform (interactive handler or an
    // API-answerable platform). When nobody can answer we must NOT dead-wait the timeout.
    const answerable = ctx.approvalAnswerable?.() ?? true;
    const unattended = this.config.tools.approvals.unattended;

    // Route to a human when answerable; otherwise apply the configured unattended fast-path. The security
    // invariant holds in every branch: host/dangerous/untrusted-derived calls are never auto-ALLOWED here.
    const askOrFastPath = async (requireAdmin: boolean): Promise<{ ok: boolean; reason: string }> => {
      if (answerable || unattended === 'wait') return this.askHuman(tool, args, ctx, reason, requireAdmin);
      if (unattended === 'deny') return { ok: false, reason: `approval required (${reason}) but no approver is available (unattended=deny)` };
      // unattended === 'gate': fail-closed for the risky categories, let the fast gate decide the rest.
      if (hostGate || untrustedDerived || tool.risk === 'dangerous') {
        const why = hostGate ? 'host access' : tool.risk === 'dangerous' ? 'dangerous tool' : 'untrusted-derived';
        return { ok: false, reason: `approval required (${reason}) but no approver is available; denied (unattended=gate, ${why})` };
      }
      const g = await gate();
      return g.approve ? { ok: true, reason: `no approver; gate approved (p=${g.probability})` } : { ok: false, reason: `no approver; gate rejected (p=${g.probability})` };
    };

    // (3) Admin-predetermined approval rules override mode/unattended for THIS call (first match wins).
    // Config is admin-controlled, so this is how an admin pre-decides which gated tools non-admins may run.
    const rule = this.matchApprovalRule(tool, ctx);
    if (rule) {
      if (rule === 'deny') return { ok: false, reason: `approval denied by admin rule (${reason})` };
      if (rule === 'ask') return askOrFastPath(hostGate);
      if (rule === 'gate') {
        // Preserve the injection safety net: a tainted sensitive call is never gate-allowed to the outside.
        if (untrustedDerived) return { ok: false, reason: `admin rule 'gate' but call is untrusted-derived; denied (${reason})` };
        const g = await gate();
        return g.approve ? { ok: true, reason: `admin rule gate approved (p=${g.probability})` } : { ok: false, reason: `admin rule gate rejected (p=${g.probability})` };
      }
      // rule === 'allow': admin's explicit standing consent (covers host/dangerous by deliberate choice),
      // EXCEPT an untrusted-content-derived sensitive call, which still falls through to the gate.
      if (!untrustedDerived) return { ok: true, reason: 'pre-authorized by admin rule' };
      const g = await gate();
      return g.approve ? { ok: true, reason: `admin rule allow; gate confirmed untrusted call (p=${g.probability})` } : { ok: false, reason: `admin rule allow but gate rejected untrusted call (p=${g.probability})` };
    }

    if (mode === 'deny') return { ok: false, reason: `approval required (${reason}) and approvals.mode=deny` };

    if (mode === 'auto') {
      // Auto mode never lets untrusted content or a policy-approve call proceed unchecked: the gate must agree.
      if (!untrustedDerived && !policyApprove && !hostGate) return { ok: true, reason: 'auto-approved' };
      if (hostGate) return askOrFastPath(true);
      const g = await gate();
      return g.approve ? { ok: true, reason: `gate approved (p=${g.probability})` } : { ok: false, reason: `approval-required call rejected by gate (p=${g.probability})` };
    }
    if (mode === 'smart') {
      const g = await gate();
      if (g.approve && tool.risk !== 'dangerous' && !hostGate) return { ok: true, reason: `gate approved (p=${g.probability})` };
    }
    return askOrFastPath(hostGate);
  }

  /**
   * First-match evaluation of the admin-predetermined approval rules for this call.
   * Returns the configured decision, or undefined when no rule applies (normal mode logic then runs).
   */
  private matchApprovalRule(tool: AnyTool, ctx: ToolContext): 'allow' | 'deny' | 'gate' | 'ask' | undefined {
    const rules = this.config.tools.approvals.rules;
    if (!rules?.length) return undefined;
    const isAdmin = ctx.principal.role === 'admin';
    for (const r of rules) {
      if (r.appliesTo === 'non-admin' && isAdmin) continue;
      if (r.appliesTo === 'admin' && !isAdmin) continue;
      if (r.tool && !globMatch(r.tool, tool.name)) continue;
      if (r.toolset && r.toolset !== tool.toolset) continue;
      if (r.risk && r.risk !== tool.risk) continue;
      return r.decision;
    }
    return undefined;
  }

  /**
   * Smart gate decision with per-run memoization + single-flight: identical gated calls (same run, tool,
   * risk, taint and arguments) reuse one in-flight/resolved judgment instead of issuing another LLM call.
   */
  private gateDecision(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext, state: RunSecurityState, taintedCtx: boolean): Promise<{ approve: boolean; probability: number }> {
    if (!this.judgment) return Promise.resolve({ approve: false, probability: 0 });
    const key = `${ctx.runId ?? ''}|${tool.name}|${tool.risk}|${taintedCtx ? 1 : 0}|${stableStringify(args)}`;
    const cached = this.gateMemo.get(key);
    if (cached) {
      this.bus.emit({ type: 'tool.gate.cache', runId: ctx.runId, data: { tool: tool.name, hit: true } });
      return cached;
    }
    const p = this.judgment
      .gateToolCall({ tool: tool.name, args, userRequest: state.userRequest, risk: tool.risk, untrustedContext: taintedCtx }, ctx.runId)
      .catch(() => ({ approve: false, probability: 0 }));
    // Bound the memo so a long-running process cannot grow it without limit (evict oldest).
    if (this.gateMemo.size >= ToolExecutor.GATE_MEMO_MAX) {
      const first = this.gateMemo.keys().next().value;
      if (first !== undefined) this.gateMemo.delete(first);
    }
    this.gateMemo.set(key, p);
    this.bus.emit({ type: 'tool.gate.cache', runId: ctx.runId, data: { tool: tool.name, hit: false } });
    return p;
  }

  private releaseRunaway(name: string): void {
    const n = this.runawayCount(name) - 1;
    if (n > 0) this.runaway.set(name, n);
    else this.runaway.delete(name);
  }

  private async askHuman(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext, reason: string, requireAdmin: boolean): Promise<{ ok: boolean; reason: string }> {
    const approved = await ctx.requestApproval({ title: `Allow ${tool.name}?`, detail: `${reason}\nArguments: ${redactSecrets(JSON.stringify(args)).text.slice(0, 1500)}`, risk: tool.risk, tool: tool.name, args, ...(requireAdmin ? { requireAdmin: true } : {}) });
    return approved ? { ok: true, reason: requireAdmin ? 'approved by admin' : 'approved by user' } : { ok: false, reason: 'denied by user' };
  }
}

/** Deterministic JSON with sorted object keys so identical logical arguments produce one memo key. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, name: string, ctl?: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl?.abort(new Error(`Tool ${name} timed out after ${ms}ms`));
      reject(new Error(`Tool ${name} timed out after ${ms}ms`));
    }, ms);
    signal?.addEventListener('abort', () => reject(new Error('Run stopped')), { once: true });
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conservative JSON-schema check for tools without a zod schema: top-level declared property
 * types and string enums. Lenient where models commonly differ (numeric/boolean strings pass),
 * strict where a mismatch changes meaning (object/array smuggled into a string field, etc.).
 */
export function checkTopLevelTypes(schema: JsonSchema, input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = input[key];
    if (v === undefined || v === null || !prop || typeof prop !== 'object') continue;
    const types = (Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []) as string[];
    if (types.length) {
      const ok = types.some((t) => {
        switch (t) {
          case 'string': return typeof v === 'string';
          case 'number': return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
          case 'integer': return (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v.trim()));
          case 'boolean': return typeof v === 'boolean' || v === 'true' || v === 'false';
          case 'array': return Array.isArray(v);
          case 'object': return typeof v === 'object' && !Array.isArray(v);
          default: return true;
        }
      });
      if (!ok) errors.push(`${key}: expected ${types.join('|')}`);
    }
    if (Array.isArray(prop.enum) && prop.enum.length && typeof v === 'string' && prop.enum.every((e) => typeof e === 'string') && !prop.enum.includes(v)) errors.push(`${key}: must be one of ${prop.enum.map(String).join(', ')}`);
    // Numeric bounds (numeric strings are compared by value, matching the lenient type check).
    const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && types.some((t) => t === 'number' || t === 'integer') ? Number(v) : undefined;
    if (num !== undefined && Number.isFinite(num)) {
      if (typeof prop.minimum === 'number' && num < prop.minimum) errors.push(`${key}: must be >= ${prop.minimum}`);
      if (typeof prop.maximum === 'number' && num > prop.maximum) errors.push(`${key}: must be <= ${prop.maximum}`);
      if (typeof prop.exclusiveMinimum === 'number' && num <= prop.exclusiveMinimum) errors.push(`${key}: must be > ${prop.exclusiveMinimum}`);
      if (typeof prop.exclusiveMaximum === 'number' && num >= prop.exclusiveMaximum) errors.push(`${key}: must be < ${prop.exclusiveMaximum}`);
    }
    if (typeof v === 'string' && types.includes('string')) {
      if (typeof prop.maxLength === 'number' && v.length > prop.maxLength) errors.push(`${key}: must be at most ${prop.maxLength} characters`);
      if (typeof prop.minLength === 'number' && v.length < prop.minLength) errors.push(`${key}: must be at least ${prop.minLength} characters`);
    }
    if (Array.isArray(v) && typeof prop.maxItems === 'number' && v.length > prop.maxItems) errors.push(`${key}: must have at most ${prop.maxItems} items`);
  }
  // A schema that forbids additional properties is honoured: undeclared keys are rejected
  // (otherwise a model/hook could smuggle parameters the tool never advertised).
  if (schema.additionalProperties === false) {
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const extra = Object.keys(input).filter((k) => !declared.has(k));
    if (extra.length) errors.push(`unknown argument(s): ${extra.join(', ')}`);
  }
  return errors;
}
