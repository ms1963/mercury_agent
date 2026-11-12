/**
 * Event recorder: persists bus events to the `events` table so runs can be
 * inspected and replayed later (debug panel, `mercury replay <runId>`).
 * High-frequency `llm.delta` events are skipped to keep the table small.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus, MercuryEvent } from './bus.js';

const SKIP = new Set(['llm.delta', 'log']);

export class EventRecorder {
  private off?: () => void;

  constructor(private db: Db, private bus: EventBus) {}

  start(): void {
    if (this.off) return;
    this.off = this.bus.on('*', (e) => {
      if (SKIP.has(e.type)) return;
      try {
        this.db.run(
          'INSERT INTO events (id, run_id, session_id, user_id, type, ts, span_id, parent_span_id, data) VALUES (?,?,?,?,?,?,?,?,?)',
          e.id, e.runId ?? null, e.sessionId ?? null, e.userId ?? null, e.type, e.ts, e.spanId ?? null, e.parentSpanId ?? null, toJson(e.data),
        );
      } catch {
        /* recording must never break the agent (e.g. db closed during shutdown) */
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** All recorded events of a run in chronological order. */
  replay(runId: string): MercuryEvent[] {
    return this.db
      .all('SELECT * FROM events WHERE run_id = ? ORDER BY ts, rowid', runId)
      .map((r) => ({
        id: String(r.id),
        type: String(r.type),
        ts: String(r.ts),
        runId: (r.run_id as string) ?? undefined,
        sessionId: (r.session_id as string) ?? undefined,
        userId: (r.user_id as string) ?? undefined,
        spanId: (r.span_id as string) ?? undefined,
        parentSpanId: (r.parent_span_id as string) ?? undefined,
        data: fromJson<Record<string, unknown>>(r.data, {}),
      }));
  }

  /** Recent runs (for the run viewer). */
  runs(userId?: string, limit = 50): Record<string, unknown>[] {
    return userId
      ? this.db.all('SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?', userId, limit)
      : this.db.all('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit);
  }

  /** Delete events older than `days` (retention). */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.run('DELETE FROM events WHERE ts < ?', cutoff).changes;
  }
}
