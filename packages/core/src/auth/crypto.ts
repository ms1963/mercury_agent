/**
 * Password hashing (scrypt) and a minimal HS256 JWT implementation (no dependency).
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(expected, actual);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface JwtPayload {
  sub: string;
  role: string;
  username: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
    if (h.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Random API token, prefixed so secret scanners and our redactor recognise it. */
export function generateApiToken(): string {
  return `mrc_${randomBytes(24).toString('base64url').replace(/[-_]/g, 'x')}`;
}
