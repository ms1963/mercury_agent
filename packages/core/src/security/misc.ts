/**
 * Rate limiting and webhook signature verification helpers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/db.js';

/**
 * Fixed-window rate limiter keyed by user/IP, backed by the SQLite database.
 *
 * Counters are persisted in the `rate_limits` table, so they survive process
 * restarts and are shared across every request handled by this process (not just
 * a single in-memory map). Each key's window is anchored to its first hit and
 * resets after `windowMs`, matching the previous in-memory semantics exactly.
 *
 * Scope note: this is single-process-shared (one SQLite file). It is NOT a
 * cross-host distributed limiter — horizontally scaled instances would each
 * enforce their own counters unless pointed at a shared external store.
 */
export class RateLimiter {
  private hits = 0;

  constructor(private db: Db, private max: number, private windowMs: number) {}

  /** Returns true when the request is allowed. */
  hit(key: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.db.get<{ window_start: number; count: number }>(
        'SELECT window_start, count FROM rate_limits WHERE bucket = ? ORDER BY window_start DESC LIMIT 1',
        key,
      );
      if (!row || now - row.window_start >= this.windowMs) {
        // New window: drop this bucket's expired rows, then open a fresh window.
        this.db.run('DELETE FROM rate_limits WHERE bucket = ? AND window_start <= ?', key, now - this.windowMs);
        this.db.run('INSERT OR REPLACE INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)', key, now);
        this.maybePruneAll(now);
        return true;
      }
      const count = row.count + 1;
      this.db.run('UPDATE rate_limits SET count = ? WHERE bucket = ? AND window_start = ?', count, key, row.window_start);
      return count <= this.max;
    });
  }

  /** Occasionally sweep expired windows for buckets that never came back. */
  private maybePruneAll(now: number): void {
    this.hits++;
    if (this.hits % 1000 !== 0) return;
    this.db.run('DELETE FROM rate_limits WHERE window_start <= ?', now - this.windowMs);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function hmacHex(secret: string, payload: string | Buffer, algo = 'sha256'): string {
  return createHmac(algo, secret).update(payload).digest('hex');
}

/** Generic `sha256=<hex>` signature (GitHub/WhatsApp/Mercury webhook style). */
export function verifyHmacSignature(secret: string, body: string | Buffer, header: string | undefined, prefix = 'sha256='): boolean {
  if (!header) return false;
  return safeEqual(header, `${prefix}${hmacHex(secret, body)}`);
}

/** Slack: v0=hmac(v0:timestamp:body), rejects requests older than 5 minutes. */
export function verifySlackSignature(secret: string, body: string, timestamp: string | undefined, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return safeEqual(signature, `v0=${hmacHex(secret, `v0:${timestamp}:${body}`)}`);
}

/** Twilio: base64(hmac-sha1(url + sorted(key+value))). */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(signature, createHmac('sha1', authToken).update(data).digest('base64'));
}

/** Microsoft Teams outgoing webhook: "HMAC <base64(hmac-sha256(body, base64key))>". */
export function verifyTeamsSignature(base64Key: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const mac = createHmac('sha256', Buffer.from(base64Key, 'base64')).update(body).digest('base64');
  return safeEqual(header, `HMAC ${mac}`);
}
