/**
 * Browser backends behind one small interface:
 *  - playwright: real headless Chromium (only if the optional `playwright` package is installed)
 *  - cdp:        attach to an existing Chrome via `tools.browser.cdpUrl` (also through playwright)
 *  - fetch:      dependency-free fallback; fetches HTML, exposes links as clickable refs
 * Pages are presented to the model as a numbered "snapshot" of text + interactive elements.
 */
import { assertSafeUrl, safeFetch } from '@mercury/core';
import { extractLinks, htmlToText, truncate } from '../util.js';

export interface BrowserPage {
  url: string;
  title: string;
  /** Readable text followed by numbered interactive elements ([1] link ...). */
  snapshot: string;
}

export interface BrowserSession {
  backend: string;
  navigate(url: string): Promise<BrowserPage>;
  snapshot(): Promise<BrowserPage>;
  /** Full HTML of the current page — the JS-rendered DOM on a real-browser backend. */
  html(): Promise<string>;
  click(ref: number): Promise<BrowserPage>;
  type(ref: number, text: string, submit?: boolean): Promise<BrowserPage>;
  screenshot(path: string): Promise<string>;
  back(): Promise<BrowserPage>;
  close(): Promise<void>;
}

/** Fetch-based fallback: no JavaScript execution, links only. */
export class FetchBrowser implements BrowserSession {
  backend = 'fetch';
  private history: string[] = [];
  private page?: { url: string; html: string; links: Array<{ text: string; href: string }> };

  constructor(private allowPrivate = false) {}

  async navigate(url: string): Promise<BrowserPage> {
    const res = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Mercury agent)' } }, { allowPrivate: this.allowPrivate });
    const html = await res.text();
    this.page = { url: res.url || url, html, links: extractLinks(html, res.url || url).slice(0, 80) };
    this.history.push(this.page.url);
    return this.render();
  }

  private render(): BrowserPage {
    if (!this.page) throw new Error('No page open. Call browser_navigate first.');
    const title = htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(this.page.html)?.[1] ?? '') || this.page.url;
    const links = this.page.links.map((l, i) => `[${i + 1}] link "${l.text}" → ${l.href}`).join('\n');
    return { url: this.page.url, title, snapshot: truncate(`${htmlToText(this.page.html)}\n\nInteractive elements:\n${links}`, 15_000) };
  }

  async snapshot(): Promise<BrowserPage> {
    return this.render();
  }

  async html(): Promise<string> {
    if (!this.page) throw new Error('No page open. Call navigate first.');
    return this.page.html;
  }

  async click(ref: number): Promise<BrowserPage> {
    const link = this.page?.links[ref - 1];
    if (!link) throw new Error(`No element [${ref}] on this page`);
    return this.navigate(link.href);
  }

  async type(): Promise<BrowserPage> {
    throw new Error('The fetch browser backend cannot fill forms. Install playwright (`npm i playwright && npx playwright install chromium`) for full browser automation.');
  }

  async screenshot(): Promise<string> {
    throw new Error('Screenshots need the playwright backend.');
  }

  async back(): Promise<BrowserPage> {
    this.history.pop();
    const prev = this.history.pop();
    if (!prev) throw new Error('No previous page');
    return this.navigate(prev);
  }

  async close(): Promise<void> {
    this.page = undefined;
  }
}

/* Loosely-typed slice of the Playwright API we use (keeps playwright optional). */
interface PwLocator {
  click(): Promise<void>;
  fill(t: string): Promise<void>;
  press(k: string): Promise<void>;
}
interface PwPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(fn: string): Promise<T>;
  locator(sel: string): PwLocator;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  goBack(): Promise<unknown>;
  waitForLoadState(s?: string): Promise<void>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  contexts?(): Array<{ pages(): PwPage[] }>;
}

/** In-page script: tags interactive elements with data-mref and returns text + element list. */
const SNAPSHOT_JS = `(() => {
  const els = [...document.querySelectorAll('a[href], button, input, textarea, select, [role=button]')].slice(0, 120);
  const items = els.map((el, i) => { el.setAttribute('data-mref', String(i + 1));
    const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 80);
    return '[' + (i + 1) + '] ' + el.tagName.toLowerCase() + (el.type ? '(' + el.type + ')' : '') + ' "' + label + '"'; });
  return (document.body ? document.body.innerText : '').slice(0, 12000) + '\\n\\nInteractive elements:\\n' + items.join('\\n');
})()`;

export class PlaywrightBrowser implements BrowserSession {
  backend = 'playwright';
  private constructor(private browser: PwBrowser, private page: PwPage) {}

  static async create(cdpUrl?: string): Promise<PlaywrightBrowser> {
    const name = 'playwright';
    const pw = (await import(name)) as { chromium: { launch(o: object): Promise<PwBrowser>; connectOverCDP(u: string): Promise<PwBrowser> } };
    const browser = cdpUrl ? await pw.chromium.connectOverCDP(cdpUrl) : await pw.chromium.launch({ headless: true });
    const existing = browser.contexts?.()[0]?.pages()[0];
    const s = new PlaywrightBrowser(browser, existing ?? (await browser.newPage()));
    if (cdpUrl) s.backend = 'cdp';
    return s;
  }

  private async render(): Promise<BrowserPage> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return { url: this.page.url(), title: await this.page.title(), snapshot: truncate(await this.page.evaluate<string>(SNAPSHOT_JS), 15_000) };
  }

  async navigate(url: string): Promise<BrowserPage> {
    await this.page.goto(url);
    return this.render();
  }
  snapshot(): Promise<BrowserPage> {
    return this.render();
  }
  async html(): Promise<string> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return this.page.evaluate<string>('document.documentElement.outerHTML');
  }
  async click(ref: number): Promise<BrowserPage> {
    await this.page.locator(`[data-mref="${ref}"]`).click();
    return this.render();
  }
  async type(ref: number, text: string, submit = false): Promise<BrowserPage> {
    const loc = this.page.locator(`[data-mref="${ref}"]`);
    await loc.fill(text);
    if (submit) await loc.press('Enter');
    return this.render();
  }
  async screenshot(path: string): Promise<string> {
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }
  async back(): Promise<BrowserPage> {
    await this.page.goBack();
    return this.render();
  }
  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Pick a backend: explicit config, else playwright when importable, else fetch. */
export async function createBrowser(backend: string, opts: { cdpUrl?: string; allowPrivate?: boolean }): Promise<BrowserSession> {
  if (backend === 'fetch') return new FetchBrowser(opts.allowPrivate);
  try {
    return await PlaywrightBrowser.create(backend === 'cdp' ? opts.cdpUrl : undefined);
  } catch (err) {
    if (backend === 'playwright' || backend === 'cdp') throw new Error(`Browser backend "${backend}" unavailable: ${String(err)}`);
    return new FetchBrowser(opts.allowPrivate);
  }
}

export interface RenderedPage {
  url: string;
  title: string;
  html: string;
  /** Backend that actually produced the HTML: 'playwright' | 'cdp' | 'fetch'. */
  backend: string;
}

/**
 * Render a page through a headless-browser backend and return its (JS-rendered) HTML.
 *
 * Used by the gated `web_read` tool for JavaScript-heavy pages. A short-lived session is
 * created, used once and closed, so it never shares state with the interactive `browser_*`
 * toolset. When `backend` resolves to `auto`/`playwright`/`cdp` but no real browser is
 * available, {@link createBrowser} transparently degrades to the dependency-free `fetch`
 * backend (plain HTTP + HTML extraction) — the returned `backend` field reports which ran.
 *
 * SSRF: the entry URL is validated with {@link assertSafeUrl} before any navigation, so a
 * real-browser backend cannot be pointed at a private/loopback/metadata address unless
 * `allowPrivate` is set. (The `fetch` backend additionally guards every redirect hop.)
 */
export async function renderPage(url: string, opts: { backend: string; cdpUrl?: string; allowPrivate?: boolean }): Promise<RenderedPage> {
  await assertSafeUrl(url, { allowPrivate: opts.allowPrivate });
  const session = await createBrowser(opts.backend, { cdpUrl: opts.cdpUrl, allowPrivate: opts.allowPrivate });
  try {
    const page = await session.navigate(url);
    const html = await session.html();
    return { url: page.url, title: page.title, html, backend: session.backend };
  } finally {
    await session.close();
  }
}
