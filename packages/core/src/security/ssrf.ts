/**
 * SSRF protection for web tools: only http(s), no credentials in URLs, and the
 * resolved IP must not be private/loopback/link-local/metadata unless allowed.
 *
 * DNS rebinding: `safeFetch` resolves a host name ONCE, validates every address and then
 * connects to exactly the validated address (pinned lookup), so a second DNS answer pointing
 * at an internal service can never be used for the actual connection. Every redirect hop is
 * re-validated the same way.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { MercuryError } from '../types/common.js';

/** Special-purpose / non-public ranges (RFC 6890 & friends). */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['2001::', 32], ['2001:10::', 28], ['2001:20::', 28],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');

/** Expand an IPv6 literal (incl. embedded dotted IPv4) into 8 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
  let v = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const o = dotted[1]!.split('.').map(Number);
    if (o.some((n) => n > 255)) return undefined;
    v = v.slice(0, -dotted[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail] = v.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * IPv4 address embedded in an IPv6 address that would be routed to that IPv4 host:
 * IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16).
 */
function embeddedV4(g: number[]): string | undefined {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4From(g[6]!, g[7]!);
  if (zero(0, 6) && (g[6] !== 0 || g[7]! > 1)) return v4From(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4From(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4From(g[1]!, g[2]!);
  return undefined;
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip.split('%')[0]!);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true; // unparsable → treat as unsafe
    const v4 = embeddedV4(g);
    if (v4 && isPrivateIp(v4)) return true;
    return BLOCKED.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
  }
  return true; // not an IP literal → unsafe by definition
}

export interface SsrfOptions {
  allowPrivate?: boolean;
  /** Injectable resolver for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = async (h: string): Promise<string[]> => (await lookup(h, { all: true, verbatim: true })).map((r) => r.address);

/** Validate a URL and return it together with the validated addresses of its host. */
async function checkUrl(raw: string, opts: SsrfOptions): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MercuryError(`Invalid URL: ${raw}`, 'invalid_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new MercuryError(`Blocked URL scheme: ${url.protocol}`, 'ssrf_blocked', 'security');
  if (url.username || url.password) throw new MercuryError('Credentials in URLs are not allowed', 'ssrf_blocked', 'security');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (opts.allowPrivate) return { url, addresses: [] };
  if (/^(localhost|metadata\.google\.internal)$/i.test(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new MercuryError(`Blocked internal host: ${host}`, 'ssrf_blocked', 'security');
  }
  const ips = isIP(host) ? [host] : await (opts.resolve ?? defaultResolve)(host);
  if (!ips.length) throw new MercuryError(`Could not resolve ${host}`, 'ssrf_blocked', 'security');
  const bad = ips.find(isPrivateIp);
  if (bad) throw new MercuryError(`Blocked private network address ${bad} for ${host}`, 'ssrf_blocked', 'security');
  return { url, addresses: ips };
}

export async function assertSafeUrl(raw: string, opts: SsrfOptions = {}): Promise<URL> {
  return (await checkUrl(raw, opts)).url;
}

/** A `lookup` that always answers with the pre-validated address (no second DNS query). */
export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    if (options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** One HTTP(S) request to `url`, connecting only to `address`. Returns a WHATWG Response. */
async function pinnedRequest(url: URL, address: string, init: RequestInit): Promise<Response> {
  const req = new Request(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined });
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  headers['accept-encoding'] ??= 'gzip, deflate, br';
  if (body) headers['content-length'] = String(body.length);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const r = send(url, { method: req.method, headers, lookup: createPinnedLookup(address), signal: init.signal ?? undefined, servername: isIP(url.hostname) ? undefined : url.hostname }, resolve);
    r.on('error', reject);
    r.end(body);
  });
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) outHeaders.append(k, item);
  }
  const status = res.statusCode ?? 502;
  if (NULL_BODY.has(status) || req.method === 'HEAD') {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers: outHeaders });
  }
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  const decoder = enc === 'gzip' || enc === 'x-gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : undefined;
  const stream: Readable = decoder ? res.pipe(decoder) : res;
  if (decoder) {
    res.on('error', (e) => decoder.destroy(e));
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, statusText: res.statusMessage, headers: outHeaders });
}

/** fetch() with SSRF checks on the initial URL and every redirect hop, pinned to validated IPs. */
export async function safeFetch(raw: string, init: RequestInit = {}, opts: SsrfOptions & { maxRedirects?: number } = {}): Promise<Response> {
  let current = raw;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const { url, addresses } = await checkUrl(current, opts);
    // Private networks explicitly allowed (e.g. a self-hosted SearXNG) → plain fetch is fine.
    const res = opts.allowPrivate ? await fetch(url, { ...init, method, body, redirect: 'manual' }) : await pinnedRequest(url, addresses[0]!, { ...init, method, body });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(res.headers.get('location')!, url).toString();
      // Like browsers: 303 (and 301/302 for POST) continue as a body-less GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method && method.toUpperCase() === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return res;
  }
  throw new MercuryError('Too many redirects', 'ssrf_blocked');
}
