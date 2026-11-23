/**
 * Tests for the web_read headless-browser backend (1.1.1 follow-up).
 *
 * web_read now has two backends that share the SAME extraction pipeline:
 *   - HTTP (default, render=false): one SSRF-guarded fetch, extract from raw HTML.
 *   - Headless browser (render=true / tools.web.render): render via tools.browser.backend,
 *     extract from the live DOM, and gracefully degrade to the dependency-free `fetch`
 *     backend when no real browser (playwright/cdp) is installed.
 *
 * Fully offline: a throw-away loopback HTTP server stands in for the public web, reached
 * with allowPrivateNetworks so the SSRF guard permits 127.0.0.1 only where intended.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Principal, type ToolResult } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { extractMainContent, renderPage } from '@mercury/tools';
import { makeMercury } from './helpers.js';

const PAGE = `<!doctype html><html><head><title>Mercury Test Page</title></head>
  <body><nav>home about contact</nav>
  <main><h1>Headline</h1><p>The distinctive main article body for web_read.</p></main>
  <footer>copyright boilerplate</footer></body></html>`;

let server: Server;
let base: string;
let ctx: Awaited<ReturnType<typeof makeMercury>>;
let p: Principal;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // allowPrivateNetworks lets the loopback test server stand in for the public web.
  ctx = await makeMercury({ tools: { web: { allowPrivateNetworks: true } } }, { startServices: true });
  p = await ctx.m.localPrincipal();
});

afterAll(async () => {
  await ctx.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('renderPage (headless-browser backend)', () => {
  it('renders a page and returns HTML the extractor can read', async () => {
    const r = await renderPage(`${base}/page`, { backend: 'fetch', allowPrivate: true });
    expect(r.backend).toBe('fetch');
    expect(r.title).toBe('Mercury Test Page');
    const { title, text } = extractMainContent(r.html);
    expect(title).toBe('Mercury Test Page');
    expect(text).toContain('distinctive main article body');
    expect(text).not.toContain('boilerplate');
  });

  it('degrades to the fetch backend when no real browser is installed (backend=auto)', async () => {
    const r = await renderPage(`${base}/page`, { backend: 'auto', allowPrivate: true });
    // playwright is not a dependency here, so `auto` falls back to the fetch backend.
    expect(['fetch', 'playwright', 'cdp']).toContain(r.backend);
    expect(r.html).toContain('<main>');
  });

  it('enforces SSRF on the entry URL before navigating', async () => {
    await expect(renderPage(`${base}/page`, { backend: 'fetch' })).rejects.toThrow(/private|blocked/i);
    await expect(renderPage('http://localhost/', { backend: 'fetch' })).rejects.toThrow(/internal|blocked/i);
    await expect(renderPage('file:///etc/passwd', { backend: 'fetch' })).rejects.toThrow(/scheme|blocked/i);
  });
});

describe('web_read tool backend selection', () => {
  const webRead = () => {
    const t = ctx.m.tools.list().find((x) => x.name === 'web_read');
    if (!t) throw new Error('web_read tool not registered');
    return t;
  };

  it('uses the HTTP backend by default (render defaults to false)', async () => {
    const tctx = directToolContext(ctx.m, p, 'cli');
    const out = (await webRead().execute({ url: `${base}/page` }, tctx)) as ToolResult;
    expect(out.data).toMatchObject({ backend: 'http', status: 200 });
    expect(out.content).toContain('HTTP 200');
    expect(out.content).toContain('distinctive main article body');
  });

  it('uses the headless-browser backend when render=true, via the same extractor', async () => {
    const tctx = directToolContext(ctx.m, p, 'cli');
    const out = (await webRead().execute({ url: `${base}/page`, render: true }, tctx)) as ToolResult;
    expect((out.data as { backend: string }).backend).toBe('fetch');
    expect(out.content).toContain('rendered via fetch');
    expect(out.content).toContain('distinctive main article body');
    expect(out.content).toContain('# Mercury Test Page');
  });

  it('can include page links from the rendered DOM', async () => {
    const tctx = directToolContext(ctx.m, p, 'cli');
    const out = (await webRead().execute({ url: `${base}/page`, render: true, include_links: true }, tctx)) as ToolResult;
    expect(out.content).toContain('distinctive main article body');
  });

  it('respects the tools.web.render config default when no arg is given', async () => {
    const renderCtx = await makeMercury({ tools: { web: { allowPrivateNetworks: true, render: true } } }, { startServices: true });
    try {
      const rp = await renderCtx.m.localPrincipal();
      const tctx = directToolContext(renderCtx.m, rp, 'cli');
      const tool = renderCtx.m.tools.list().find((x) => x.name === 'web_read')!;
      const out = (await tool.execute({ url: `${base}/page` }, tctx)) as ToolResult;
      expect((out.data as { backend: string }).backend).toBe('fetch');
      expect(out.content).toContain('rendered via fetch');
    } finally {
      await renderCtx.close();
    }
  });
});
