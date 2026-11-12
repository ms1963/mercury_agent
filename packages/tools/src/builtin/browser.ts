/** Browser tools (toolset "browser"). One browser session per user, created lazily. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defineTool, newId, type AnyTool, type ToolContext } from '@mercury/core';
import { createBrowser, type BrowserPage, type BrowserSession } from '../browser/backends.js';
import { bool, num, params, str } from '../util.js';

async function sessionOf(ctx: ToolContext): Promise<BrowserSession> {
  const extra = ctx.services.extra;
  const sessions = (extra.browsers ??= new Map<string, BrowserSession>()) as Map<string, BrowserSession>;
  let s = sessions.get(ctx.principal.userId);
  if (!s) {
    const cfg = ctx.services.config.tools;
    s = await createBrowser(cfg.browser.backend, { cdpUrl: cfg.browser.cdpUrl, allowPrivate: cfg.web.allowPrivateNetworks });
    sessions.set(ctx.principal.userId, s);
  }
  return s;
}

const show = (p: BrowserPage) => ({ content: `URL: ${p.url}\nTitle: ${p.title}\n\n${p.snapshot}`, untrusted: true });

export const browserNavigate = defineTool<{ url: string }>({
  name: 'browser_navigate',
  description: 'Open a URL in the browser and return a text snapshot with numbered interactive elements.',
  toolset: 'browser',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ url: str('URL to open') }, ['url']),
  async execute(a, ctx) {
    return show(await (await sessionOf(ctx)).navigate(a.url));
  },
});

export const browserSnapshot = defineTool<Record<string, never>>({
  name: 'browser_snapshot',
  description: 'Return the current page snapshot again.',
  toolset: 'browser',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({}),
  async execute(_a, ctx) {
    return show(await (await sessionOf(ctx)).snapshot());
  },
});

export const browserClick = defineTool<{ ref: number }>({
  name: 'browser_click',
  description: 'Click the interactive element with the given [number] from the snapshot.',
  toolset: 'browser',
  risk: 'moderate',
  untrustedOutput: true,
  parameters: params({ ref: num('Element number') }, ['ref']),
  async execute(a, ctx) {
    return show(await (await sessionOf(ctx)).click(a.ref));
  },
});

export const browserType = defineTool<{ ref: number; text: string; submit?: boolean }>({
  name: 'browser_type',
  description: 'Type text into an input element; submit=true presses Enter.',
  toolset: 'browser',
  risk: 'moderate',
  sensitive: true,
  untrustedOutput: true,
  parameters: params({ ref: num('Element number'), text: str('Text to type'), submit: bool('Press Enter afterwards') }, ['ref', 'text']),
  async execute(a, ctx) {
    return show(await (await sessionOf(ctx)).type(a.ref, a.text, a.submit));
  },
});

export const browserBack = defineTool<Record<string, never>>({
  name: 'browser_back',
  description: 'Go back to the previous page.',
  toolset: 'browser',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({}),
  async execute(_a, ctx) {
    return show(await (await sessionOf(ctx)).back());
  },
});

export const browserScreenshot = defineTool<Record<string, never>>({
  name: 'browser_screenshot',
  description: 'Take a full-page screenshot (playwright backend) and attach it.',
  toolset: 'browser',
  risk: 'safe',
  parameters: params({}),
  async execute(_a, ctx) {
    const dir = join(ctx.services.config.dataDir, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const path = await (await sessionOf(ctx)).screenshot(join(dir, `${newId('shot')}.png`));
    const att = await ctx.services.attachments.save(ctx.principal.userId, 'screenshot.png', (await import('node:fs')).readFileSync(path), 'image/png');
    return { content: `Screenshot saved (${att.id}).`, attachments: [att] };
  },
});

export const browserTools: AnyTool[] = [browserNavigate, browserSnapshot, browserClick, browserType, browserBack, browserScreenshot];
