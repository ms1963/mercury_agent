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
