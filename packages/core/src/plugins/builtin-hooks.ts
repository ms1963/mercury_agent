/**
 * Built-in hook handlers configured via `hooks:` in config:
 *   - { event: before_tool_call, type: log }        → structured log line
 *   - { event: run_end, type: webhook, url: ... }   → POST JSON (alerts, integrations)
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { redactDeep } from '../security/redact.js';
import { HOOK_NAMES, type HookManager, type HookName } from './hooks.js';

export function installConfiguredHooks(config: MercuryConfig, hooks: HookManager, logger: Logger): void {
  for (const h of config.hooks) {
    const events = h.event === '*' ? HOOK_NAMES : [h.event as HookName];
    for (const event of events) {
      if (!HOOK_NAMES.includes(event)) {
        logger.warn(`unknown hook event in config: ${h.event}`);
        continue;
      }
      if (h.type === 'log') {
        hooks.register(event, `config-log-${event}`, (p) => {
          logger.info(`hook ${event}`, summarize(p));
        }, 1000);
      } else if (h.type === 'webhook' && h.url) {
        const url = h.url;
        hooks.register(event, `config-webhook-${event}`, (p) => {
          // Fire-and-forget: alerts must never slow down or break the agent.
          void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, payload: redactDeep(summarize(p)) }) }).catch(() => undefined);
        }, 1000);
      }
    }
  }
}

function summarize(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'messages' && Array.isArray(v)) out.messages = v.length;
    else if (k === 'principal' && v && typeof v === 'object') out.user = (v as { username?: string }).username;
    else out[k] = typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  return out;
}
