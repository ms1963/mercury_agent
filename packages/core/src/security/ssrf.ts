/**
 * SSRF protection for web tools: only http(s), no credentials in URLs, and the
 * resolved IP must not be private/loopback/link-local/metadata unless allowed.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MercuryError } from '../types/common.js';

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateIp(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export interface SsrfOptions {
  allowPrivate?: boolean;
  /** Injectable resolver for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

export async function assertSafeUrl(raw: string, opts: SsrfOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MercuryError(`Invalid URL: ${raw}`, 'invalid_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new MercuryError(`Blocked URL scheme: ${url.protocol}`, 'ssrf_blocked', 'security');
  if (url.username || url.password) throw new MercuryError('Credentials in URLs are not allowed', 'ssrf_blocked', 'security');
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|metadata\.google\.internal)$/i.test(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new MercuryError(`Blocked internal host: ${host}`, 'ssrf_blocked', 'security');
  }
  const ips = isIP(host) ? [host] : await (opts.resolve ?? (async (h) => (await lookup(h, { all: true })).map((r) => r.address)))(host);
  const bad = ips.find(isPrivateIp);
  if (bad) throw new MercuryError(`Blocked private network address ${bad} for ${host}`, 'ssrf_blocked', 'security');
  return url;
}

/** fetch() with SSRF checks on the initial URL and every redirect hop. */
export async function safeFetch(raw: string, init: RequestInit = {}, opts: SsrfOptions & { maxRedirects?: number } = {}): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await assertSafeUrl(current, opts);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    return res;
  }
  throw new MercuryError('Too many redirects', 'ssrf_blocked');
}
