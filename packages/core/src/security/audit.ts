/**
 * Append-only, hash-chained audit log. Each entry stores sha256(prev_hash + entry);
 * `verify()` detects any tampering. SQL triggers forbid UPDATE/DELETE.
 *
 * When a key is set (`setKey`, derived from the instance secret), new entries are
 * chained with HMAC-SHA256 and stored with a `k1:` prefix. Someone with write access
 * to the database file but not to the secret can then no longer drop the triggers
 * and recompute a valid chain. Older unkeyed entries still verify; once the first
 * keyed entry exists, any later unkeyed entry breaks the chain (no downgrade).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Db } from '../db/db.js';
import { redactDeep } from './redact.js';

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  details: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  target?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

const GENESIS = '0'.repeat(64);
const digest = (prev: string, ts: string, actor: string, action: string, target: string, details: string) =>
  createHash('sha256').update([prev, ts, actor, action, target, details].join('\u241f')).digest('hex');

const KEYED = 'k1:';
const keyedDigest = (key: string, prev: string, ts: string, actor: string, action: string, target: string, details: string) =>
  KEYED + createHmac('sha256', key).update([prev, ts, actor, action, target, details].join('\u241f')).digest('hex');

export class AuditLog {
  private key: string | undefined;
  constructor(private db: Db, private enabled = true) {}

  /** Enable keyed (HMAC) chaining for new entries. */
  setKey(key: string | undefined): void {
    this.key = key || undefined;
  }

  record(actor: string, action: string, target = '', details: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const ts = new Date().toISOString();
    const detailsJson = JSON.stringify(redactDeep(details));
    this.db.transaction(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
      const hash = this.key ? keyedDigest(this.key, prev, ts, actor, action, target, detailsJson) : digest(prev, ts, actor, action, target, detailsJson);
      this.db.run('INSERT INTO audit (ts, actor, action, target, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?)', ts, actor, action, target, detailsJson, prev, hash);
    });
  }

  list(limit = 100, offset = 0): AuditEntry[] {
    return this.db.all<AuditEntry>('SELECT * FROM audit ORDER BY seq DESC LIMIT ? OFFSET ?', limit, offset);
  }

  /**
   * Filtered, paginated query over the audit log (newest first). All filters are optional
   * and combine with AND. `action` matches either exactly or as a `prefix.` (e.g. `token`
   * matches `token.issue` and `token.revoke`); `since`/`until` are ISO timestamps.
   */
  query(opts: AuditQuery = {}): { entries: AuditEntry[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (clause: string, ...values: (string | number)[]): void => {
      where.push(clause);
      params.push(...values);
    };
    if (opts.actor) add('actor = ?', opts.actor);
    if (opts.target) add('target = ?', opts.target);
    if (opts.action) add('(action = ? OR action LIKE ?)', opts.action, `${opts.action}.%`);
    if (opts.since) add('ts >= ?', opts.since);
    if (opts.until) add('ts <= ?', opts.until);
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit${clause}`, ...params)?.n ?? 0;
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const entries = this.db.all<AuditEntry>(`SELECT * FROM audit${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    return { entries, total };
  }

  /** Recompute the chain. Returns the first broken sequence number, or null if intact. */
  verify(): { ok: boolean; brokenAt: number | null; count: number; keyed: number } {
    let prev = GENESIS;
    let keyed = 0;
    const rows = this.db.all<AuditEntry>('SELECT * FROM audit ORDER BY seq ASC');
    for (const r of rows) {
      const isKeyed = r.hash.startsWith(KEYED);
      // Keyed entries need the key; after the first keyed entry, unkeyed ones are a downgrade.
      const fail = (): { ok: boolean; brokenAt: number | null; count: number; keyed: number } => ({ ok: false, brokenAt: r.seq, count: rows.length, keyed });
      if (isKeyed && !this.key) return fail();
      if (!isKeyed && keyed > 0) return fail();
      const fields = [prev, r.ts, r.actor, r.action, r.target ?? '', r.details ?? ''] as const;
      const expected = isKeyed ? keyedDigest(this.key as string, ...fields) : digest(...fields);
      if (r.prev_hash !== prev || r.hash !== expected) return fail();
      if (isKeyed) keyed++;
      prev = r.hash;
    }
    return { ok: true, brokenAt: null, count: rows.length, keyed };
  }
}

/** Load the audit-chain HMAC key (env `MERCURY_AUDIT_KEY` wins), creating a 0600 key file on first use.
 *  It is separate from the JWT secret so rotating the JWT secret does not invalidate the audit chain. */
export function loadOrCreateAuditKey(file: string): string {
  if (process.env.MERCURY_AUDIT_KEY) return process.env.MERCURY_AUDIT_KEY;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}
