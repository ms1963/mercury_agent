/**
 * Event hooks: synchronous interception points (unlike the fire-and-forget EventBus).
 * A hook handler may return a patch object, e.g. `{ block: 'reason' }` or `{ args }`,
 * which is merged and returned to the caller. Used for tool interception, guardrails,
 * logging, alerts, metrics and webhooks.
 */

export type HookName =
  | 'run_start'
  | 'run_end'
  | 'before_llm_call'
  | 'after_llm_call'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'message_received'
  | 'message_sent'
  | 'output'
  | 'memory_write'
  | 'attachment_scan'
  | 'error';

export const HOOK_NAMES: HookName[] = ['run_start', 'run_end', 'before_llm_call', 'after_llm_call', 'before_tool_call', 'after_tool_call', 'message_received', 'message_sent', 'output', 'memory_write', 'attachment_scan', 'error'];

export type HookPayload = Record<string, unknown>;
export type HookPatch = Record<string, unknown> | void | undefined;
export type HookHandler = (payload: HookPayload) => HookPatch | Promise<HookPatch>;

interface Registered {
  name: string;
  handler: HookHandler;
  priority: number;
}

export class HookManager {
  private hooks = new Map<HookName, Registered[]>();

  /** Register a handler. Lower priority runs first. Returns an unregister function. */
  register(hook: HookName, name: string, handler: HookHandler, priority = 100): () => void {
    const list = this.hooks.get(hook) ?? [];
    list.push({ name, handler, priority });
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(hook, list);
    return () => this.hooks.set(hook, (this.hooks.get(hook) ?? []).filter((r) => r.handler !== handler));
  }

  /** Run all handlers; each sees the payload merged with previous patches. A `block` stops the chain. */
  async run(hook: HookName, payload: HookPayload): Promise<Record<string, unknown>> {
    let merged: Record<string, unknown> = {};
    for (const r of this.hooks.get(hook) ?? []) {
      try {
        const patch = await r.handler({ ...payload, ...merged });
        if (patch && typeof patch === 'object') merged = { ...merged, ...patch };
        if (merged.block) break;
      } catch (err) {
        console.error(`[hooks] ${hook}/${r.name} failed:`, err);
      }
    }
    return merged;
  }

  list(): Array<{ hook: HookName; name: string; priority: number }> {
    return [...this.hooks.entries()].flatMap(([hook, rs]) => rs.map((r) => ({ hook, name: r.name, priority: r.priority })));
  }
}
