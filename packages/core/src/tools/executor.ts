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
    const denied = this.policy.check(ctx.principal, 'tool.use', { tool: { name: tool.name, toolset: tool.toolset, risk: tool.risk } });
    if (denied) return fail(`Permission denied: ${denied}`, 'denied');

    let args = call.arguments ?? {};
    if (tool.schema) {
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) return fail(`Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      args = parsed.data as Record<string, unknown>;
    } else {
      const missing = (tool.parameters.required ?? []).filter((k) => args[k] === undefined);
      if (missing.length) return fail(`Missing required arguments for ${tool.name}: ${missing.join(', ')}`);
    }

    this.bus.emit({ type: 'tool.call', runId: ctx.runId, sessionId: ctx.sessionId, data: { id: call.id, name: tool.name, args: redactSecrets(JSON.stringify(args)).text, risk: tool.risk } });

    const approval = await this.approve(tool, args, ctx, state);
    if (!approval.ok) {
      this.audit?.record(ctx.principal.username, 'tool.denied', tool.name, { args, reason: approval.reason });
      return fail(`Tool call not approved: ${approval.reason}. Ask the user how to proceed.`, 'denied');
    }

    const before = await this.hooks?.run('before_tool_call', { tool: tool.name, args, principal: ctx.principal, runId: ctx.runId });
    if (before?.block) return fail(`Blocked by hook: ${String(before.block)}`, 'denied');
    if (before?.args) args = before.args as Record<string, unknown>;

    let result: ToolResult;
    try {
      const raw = await withTimeout(tool.execute(args, ctx), tool.timeoutMs ?? this.config.agent.toolTimeoutMs, ctx.signal, tool.name);
      result = typeof raw === 'string' ? { content: raw } : raw;
    } catch (err) {
      result = { content: errorMessage(err), isError: true };
    }

    const afterHook = await this.hooks?.run('after_tool_call', { tool: tool.name, args, result, runId: ctx.runId });
    if (afterHook?.result) result = afterHook.result as ToolResult;

    let content = this.config.security.redactSecrets ? redactSecrets(result.content).text : result.content;
    content = truncate(content, tool.maxOutputChars ?? 20_000);
    const untrusted = (tool.untrustedOutput || result.untrusted) && !result.isError;
    if (untrusted) {
      state.untrustedSeen = true;
      const scan = scanForInjection(content);
      if (scan.suspicious) this.bus.emit({ type: 'guardrail', runId: ctx.runId, data: { layer: 'tool_output', tool: tool.name, injection: scan, blocked: false } });
      content = spotlight(content, `tool:${tool.name}`);
    }
    const durationMs = Date.now() - started;
    const ok = !result.isError;
    if (tool.risk !== 'safe') this.audit?.record(ctx.principal.username, 'tool.exec', tool.name, { args, ok, runId: ctx.runId });
    this.bus.emit({ type: 'tool.result', runId: ctx.runId, sessionId: ctx.sessionId, data: { id: call.id, name: tool.name, ok, durationMs, untrusted, preview: content.slice(0, 1000) } });
    return { call: { ...call, arguments: args }, result, modelContent: ok ? content : `Error: ${content}`, ok, durationMs };
  }

  /** Decide whether a call may run, consulting policy, the smart gate and/or a human. */
  private async approve(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext, state: RunSecurityState): Promise<{ ok: boolean; reason: string }> {
    const reasons: string[] = [];
    if (tool.risk === 'dangerous') reasons.push(`${tool.name} is a dangerous tool`);
    const per = tool.needsApproval?.(args, ctx);
    if (per) reasons.push(typeof per === 'string' ? per : `${tool.name} requires approval for these arguments`);
    const untrustedDerived = state.untrustedSeen && !!tool.sensitive;
    if (untrustedDerived) reasons.push('the context contains untrusted content and this tool acts on the outside world');
    if (!reasons.length) return { ok: true, reason: 'not required' };

    const mode = this.config.tools.approvals.mode;
    const reason = reasons.join('; ');
    if (mode === 'deny') return { ok: false, reason: `approval required (${reason}) and approvals.mode=deny` };

    const gate = async () =>
      this.judgment?.gateToolCall({ tool: tool.name, args, userRequest: state.userRequest, risk: tool.risk, untrustedContext: state.untrustedSeen }, ctx.runId) ?? { approve: false, probability: 0 };

    if (mode === 'auto') {
      // Auto mode never lets untrusted content alone drive a sensitive action: the gate must agree.
      if (!untrustedDerived) return { ok: true, reason: 'auto-approved' };
      const g = await gate();
      return g.approve ? { ok: true, reason: `gate approved (p=${g.probability})` } : { ok: false, reason: `untrusted-derived call rejected by gate (p=${g.probability})` };
    }
    if (mode === 'smart') {
      const g = await gate();
      if (g.approve && tool.risk !== 'dangerous') return { ok: true, reason: `gate approved (p=${g.probability})` };
    }
    const approved = await ctx.requestApproval({ title: `Allow ${tool.name}?`, detail: `${reason}\nArguments: ${redactSecrets(JSON.stringify(args)).text.slice(0, 1500)}`, risk: tool.risk, tool: tool.name, args });
    return approved ? { ok: true, reason: 'approved by user' } : { ok: false, reason: 'denied by user' };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool ${name} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', () => reject(new Error('Run stopped')), { once: true });
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
