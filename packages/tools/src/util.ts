/** Small helpers shared by built-in tools. */
import type { JsonSchema, ToolContext } from '@mercury/core';

/** Build an object JSON schema: `params({ path: str('File path') }, ['path'])`. */
export function params(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const str = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: 'string', description, ...extra });
export const num = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: 'number', description, ...extra });
export const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
export const strEnum = (values: string[], description: string): JsonSchema => ({ type: 'string', enum: values, description });
export const arr = (items: JsonSchema, description: string): JsonSchema => ({ type: 'array', items, description });
export const anyObj = (description: string): JsonSchema => ({ type: 'object', description, additionalProperties: true });

/** Resolve a user/model-provided path inside the path jail, relative to the run's workdir. */
export function resolvePath(ctx: ToolContext, p: string | undefined): string {
  return ctx.services.jail.check(p && p.length ? p : '.', ctx.workdir);
}

/** Snapshot a file before modifying it so `/rollback` can restore it. */
export function snapshot(ctx: ToolContext, path: string, label: string): void {
  if (!ctx.runId) return;
  ctx.services.checkpoints.snapshot(ctx.runId, path, label, ctx.sessionId);
}

export function truncate(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}

/** Throws if the caller lacks admin role (used by system-level tools). */
export function requireAdmin(ctx: ToolContext, what: string): void {
  if (ctx.principal.role !== 'admin') throw new Error(`${what} requires an admin user`);
}

/** Strip HTML to readable text (good enough for web pages and emails). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/** Extract `[text](href)` style links from HTML. */
export function extractLinks(html: string, base: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = new URL(m[1]!, base).toString();
      const text = htmlToText(m[2]!).slice(0, 80);
      if (href.startsWith('http')) out.push({ text: text || href, href });
    } catch {
      /* ignore malformed links */
    }
  }
  return out;
}
