/**
 * Rate limiting and webhook signature verification helpers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Fixed-window rate limiter keyed by user/IP. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Returns true when the request is allowed. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.max;
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
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
