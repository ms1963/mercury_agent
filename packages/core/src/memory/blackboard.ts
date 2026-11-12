/**
 * Blackboard: shared, append-only scratch space for a multi-agent run.
 * Agents in a Blackboard workflow post findings under keys; others read them.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { nowIso } from '../types/common.js';

export interface BlackboardEntry {
  key: string;
  value: unknown;
  author?: string;
  createdAt: string;
}

export class Blackboard {
  constructor(private db: Db) {}

  post(runId: string, key: string, value: unknown, author?: string): void {
    this.db.run('INSERT INTO blackboard (run_id, key, value, author, created_at) VALUES (?,?,?,?,?)', runId, key, toJson(value), author, nowIso());
  }

  /** All entries (optionally for one key), oldest first. */
  read(runId: string, key?: string): BlackboardEntry[] {
    const rows = key
      ? this.db.all<{ key: string; value: string; author: string | null; created_at: string }>('SELECT * FROM blackboard WHERE run_id = ? AND key = ? ORDER BY id', runId, key)
      : this.db.all<{ key: string; value: string; author: string | null; created_at: string }>('SELECT * FROM blackboard WHERE run_id = ? ORDER BY id', runId);
    return rows.map((r) => ({ key: r.key, value: fromJson(r.value, null), author: r.author ?? undefined, createdAt: r.created_at }));
  }

  /** Latest value per key. */
  snapshot(runId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.read(runId)) out[e.key] = e.value;
    return out;
  }

  render(runId: string): string {
    return this.read(runId)
      .map((e) => `[${e.author ?? 'agent'}] ${e.key}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`)
      .join('\n');
  }
}
