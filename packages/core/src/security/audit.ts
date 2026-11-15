/**
 * Append-only, hash-chained audit log. Each entry stores sha256(prev_hash + entry);
 * `verify()` detects any tampering. SQL triggers forbid UPDATE/DELETE.
 */
import { createHash } from 'node:crypto';
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

export class AuditLog {
  constructor(private db: Db, private enabled = true) {}

  record(actor: string, action: string, target = '', details: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const ts = new Date().toISOString();
    const detailsJson = JSON.stringify(redactDeep(details));
    this.db.transaction(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
      const hash = digest(prev, ts, actor, action, target, detailsJson);
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
  verify(): { ok: boolean; brokenAt: number | null; count: number } {
    let prev = GENESIS;
    const rows = this.db.all<AuditEntry>('SELECT * FROM audit ORDER BY seq ASC');
    for (const r of rows) {
      const expected = digest(prev, r.ts, r.actor, r.action, r.target ?? '', r.details ?? '');
      if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, brokenAt: r.seq, count: rows.length };
      prev = r.hash;
    }
    return { ok: true, brokenAt: null, count: rows.length };
  }
}
