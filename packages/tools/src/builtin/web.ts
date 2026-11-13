/**
 * Web tools (toolset "web"): search, fetch/extract, raw HTTP, RSS and weather.
 * Every request goes through `safeFetch` (SSRF protection); all output is untrusted.
 */
import { defineTool, safeFetch, type AnyTool, type ToolContext } from '@mercury/core';
import { anyObj, extractLinks, htmlToText, num, params, str, strEnum, truncate } from '../util.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const fetchOpts = (ctx: ToolContext) => ({ allowPrivate: ctx.services.config.tools.web.allowPrivateNetworks });

async function readCapped(res: Response, max: number): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, max).toString('utf8');
}

/** Search providers. DuckDuckGo (HTML endpoint) needs no key; SearXNG/Brave require config. */
export async function webSearch(ctx: ToolContext, query: string, n: number): Promise<SearchHit[]> {
  const cfg = ctx.services.config.tools.web;
  if (cfg.searchProvider === 'searxng') {
    if (!cfg.searxngUrl) throw new Error('tools.web.searxngUrl is not configured');
    const res = await safeFetch(`${cfg.searxngUrl.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`, {}, { allowPrivate: true });
    const data = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (data.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
  if (cfg.searchProvider === 'brave') {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error('BRAVE_API_KEY is not set');
    const res = await safeFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
    const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (data.web?.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description ?? '') }));
  }
  const res = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Mercury agent)' } });
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    let url = m[1]!;
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    hits.push({ title: htmlToText(m[2]!), url, snippet: htmlToText(m[3]!) });
    if (hits.length >= n) break;
  }
  return hits;
}

export const webSearchTool = defineTool<{ query: string; max_results?: number }>({
  name: 'web_search',
  description: 'Search the web. Returns titles, URLs and snippets.',
  toolset: 'web',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ query: str('Search query'), max_results: num('Number of results (default 5)') }, ['query']),
  async execute(a, ctx) {
    const hits = await webSearch(ctx, a.query, Math.min(a.max_results ?? 5, 10));
    return { content: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n') || 'No results.', data: hits };
  },
});

export const webFetch = defineTool<{ url: string; format?: string; max_chars?: number }>({
  name: 'web_fetch',
  description: 'Fetch a web page and return readable text (format=text), raw HTML (html) or the list of links (links).',
  toolset: 'web',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ url: str('URL'), format: strEnum(['text', 'html', 'links'], 'Output format'), max_chars: num('Max characters') }, ['url']),
  async execute(a, ctx) {
    const res = await safeFetch(a.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Mercury agent)' } }, fetchOpts(ctx));
    const body = await readCapped(res, ctx.services.config.tools.web.maxBytes);
    const type = res.headers.get('content-type') ?? '';
    let out = body;
    if (a.format === 'links') out = extractLinks(body, a.url).map((l) => `- [${l.text}](${l.href})`).join('\n');
    else if (a.format !== 'html' && type.includes('html')) out = htmlToText(body);
    return truncate(`HTTP ${res.status} ${type}\n\n${out}`, a.max_chars ?? 20_000);
  },
});

export const httpRequest = defineTool<{ url: string; method?: string; headers?: Record<string, string>; body?: string }>({
  name: 'http_request',
  description: 'Make an HTTP request (GET/POST/PUT/PATCH/DELETE) to an API and return status, headers and body.',
  toolset: 'web',
  risk: 'moderate',
  untrustedOutput: true,
  sensitive: true,
  needsApproval: (a) => (a.method && a.method.toUpperCase() !== 'GET' ? `${a.method} ${a.url}` : undefined),
  parameters: params({ url: str('URL'), method: strEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'HTTP method'), headers: anyObj('Request headers'), body: str('Request body') }, ['url']),
  async execute(a, ctx) {
    const res = await safeFetch(a.url, { method: a.method ?? 'GET', headers: a.headers, body: a.body }, fetchOpts(ctx));
    const body = await readCapped(res, ctx.services.config.tools.web.maxBytes);
    const lines: string[] = [];
    res.headers.forEach((v, k) => lines.push(`${k}: ${v}`));
    const headers = lines.slice(0, 20).join('\n');
    return { content: truncate(`HTTP ${res.status}\n${headers}\n\n${body}`), isError: res.status >= 400 };
  },
});

/** Minimal RSS/Atom parser (title, link, date, summary). */
export function parseFeed(xml: string): Array<{ title: string; link: string; date?: string; summary?: string }> {
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);
  const tag = (s: string, t: string) => {
    const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`).exec(s);
    return m ? htmlToText(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : undefined;
  };
  return items.map((it) => ({
    title: tag(it, 'title') ?? '(untitled)',
    link: tag(it, 'link') || /<link[^>]+href="([^"]+)"/.exec(it)?.[1] || '',
    date: tag(it, 'pubDate') ?? tag(it, 'updated') ?? tag(it, 'published'),
    summary: (tag(it, 'description') ?? tag(it, 'summary'))?.slice(0, 300),
  }));
}

export const rssRead = defineTool<{ url: string; max_items?: number }>({
  name: 'rss_read',
  description: 'Read an RSS or Atom feed and list the latest items.',
  toolset: 'web',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ url: str('Feed URL'), max_items: num('Max items (default 10)') }, ['url']),
  async execute(a, ctx) {
    const res = await safeFetch(a.url, {}, fetchOpts(ctx));
    const items = parseFeed(await readCapped(res, ctx.services.config.tools.web.maxBytes)).slice(0, a.max_items ?? 10);
    return { content: items.map((i) => `- ${i.title} (${i.date ?? 'no date'})\n  ${i.link}\n  ${i.summary ?? ''}`).join('\n') || 'Feed has no items.', data: items };
  },
});

export const weather = defineTool<{ location: string }>({
  name: 'weather',
  description: 'Current weather and 3-day forecast for a place (Open-Meteo, no API key).',
  toolset: 'web',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ location: str('City or place name') }, ['location']),
  async execute(a, ctx) {
    const geo = (await (await safeFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(a.location)}`)).json()) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> };
    const place = geo.results?.[0];
    if (!place) return { content: `Unknown location "${a.location}"`, isError: true };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3&timezone=auto`;
    const w = (await (await safeFetch(url)).json()) as { current?: Record<string, number>; daily?: Record<string, Array<number | string>> };
    const days = (w.daily?.time ?? []).map((d, i) => `${d}: ${w.daily!.temperature_2m_min![i]}–${w.daily!.temperature_2m_max![i]}°C, rain ${w.daily!.precipitation_sum![i]}mm`);
    return `${place.name}${place.country ? `, ${place.country}` : ''}: now ${w.current?.temperature_2m}°C, wind ${w.current?.wind_speed_10m} km/h\n${days.join('\n')}`;
  },
});

export const webTools: AnyTool[] = [webSearchTool, webFetch, httpRequest, rssRead, weather];
