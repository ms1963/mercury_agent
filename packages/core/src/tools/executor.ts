/**
 * ToolExecutor — the guarded pipeline every tool call passes through:
 *
 *   lookup → enabled? → RBAC/ABAC → argument validation → approval decision
 *   (risk, per-call rules, untrusted-derived sensitive calls; manual/auto/smart/deny)
 *   → before_tool_call hooks → execute (timeout, abort) → secret redaction
 *   → spotlighting of untrusted output → after_tool_call hooks → audit + events
 */
import type { MercuryConfig } from '../config/schema.js';
import type { PolicyEngine } from '../auth/policy.js';
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
import type { ToolCall } from '../types/messages.js';
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

  async execute(call: ToolCall, ctx: ToolContext, state: RunSecurityState): Promise<ExecutedTool> {
    const started = Date.now();
    const fail = (content: string, kind = 'error'): ExecutedTool => {
      this.bus.emit({ type: kind === 'denied' ? 'tool.denied' : 'tool.result', runId: ctx.runId, data: { id: call.id, name: call.name, ok: false, error: content, durationMs: Date.now() - started } });
      return { call, result: { content, isError: true }, modelContent: `Error: ${content}`, ok: false, durationMs: Date.now() - started };
    };

    const tool = this.registry.get(call.name);
    if (!tool) return fail(`Unknown tool "${call.name}". Available tools are listed in your tool definitions.`);
    if (!this.registry.isEnabled(tool, ctx.platform, ctx.allowedToolsets)) return fail(`Tool "${call.name}" is disabled for this agent/platform.`, 'denied');
    const denied = this.policy.check(ctx.principal, 'tool.use', { tool: { name: tool.name, toolset: tool.toolset, risk: tool.risk }, profile: ctx.personality });
    if (denied) return fail(`Permission denied: ${denied}`, 'denied');

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
      try {
        const raw = await withTimeout(tool.execute(args, { ...ctx, signal: callCtl.signal }), tool.timeoutMs ?? this.config.agent.toolTimeoutMs, ctx.signal, tool.name, callCtl);
        result = typeof raw === 'string' ? { content: raw } : raw;
      } catch (err) {
        result = { content: errorMessage(err), isError: true };
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
    if (mode === 'deny') return { ok: false, reason: `approval required (${reason}) and approvals.mode=deny` };

    const gate = async () =>
      this.judgment?.gateToolCall({ tool: tool.name, args, userRequest: state.userRequest, risk: tool.risk, untrustedContext: taintedCtx }, ctx.runId) ?? { approve: false, probability: 0 };

    if (mode === 'auto') {
      // Auto mode never lets untrusted content or a policy-approve call proceed unchecked: the gate must agree.
      if (!untrustedDerived && !policyApprove && !hostGate) return { ok: true, reason: 'auto-approved' };
      if (hostGate) return this.askHuman(tool, args, ctx, reason, true);
      const g = await gate();
      return g.approve ? { ok: true, reason: `gate approved (p=${g.probability})` } : { ok: false, reason: `approval-required call rejected by gate (p=${g.probability})` };
    }
    if (mode === 'smart') {
      const g = await gate();
      if (g.approve && tool.risk !== 'dangerous' && !hostGate) return { ok: true, reason: `gate approved (p=${g.probability})` };
    }
    return this.askHuman(tool, args, ctx, reason, hostGate);
  }

  private async askHuman(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext, reason: string, requireAdmin: boolean): Promise<{ ok: boolean; reason: string }> {
    const approved = await ctx.requestApproval({ title: `Allow ${tool.name}?`, detail: `${reason}\nArguments: ${redactSecrets(JSON.stringify(args)).text.slice(0, 1500)}`, risk: tool.risk, tool: tool.name, args, ...(requireAdmin ? { requireAdmin: true } : {}) });
    return approved ? { ok: true, reason: requireAdmin ? 'approved by admin' : 'approved by user' } : { ok: false, reason: 'denied by user' };
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
