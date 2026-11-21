/**
 * Real, durable {@link TraceStore} backed by the shared SQLite {@link Db} (table `run_traces`,
 * migration #8). No mocks: the time-travel service depends only on the {@link TraceStore} port
 * and this is the single concrete implementation used everywhere, including tests — mirroring the
 * persistence convention of the distill/learning/reliability subsystems.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { nowIso } from '../types/common.js';
import type { NewRunTrace, ReplayEdit, RunTraceRecord, TraceSeed, TraceStore } from './ports.js';

interface TraceRow {
  run_id: string;
  session_id: string | null;
  user_id: string | null;
  input: string | null;
  seed: string;
  steps: number;
  parent_run_id: string | null;
  from_step: number | null;
  edits: string | null;
  deltas: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTrace(r: TraceRow): RunTraceRecord {
  return {
    runId: r.run_id,
    sessionId: r.session_id ?? undefined,
    userId: r.user_id ?? undefined,
    input: r.input ?? undefined,
    seed: fromJson<TraceSeed>(r.seed, {}),
    steps: Number(r.steps) || 0,
    parentRunId: r.parent_run_id ?? undefined,
    fromStep: r.from_step ?? undefined,
    edits: r.edits ? fromJson<ReplayEdit>(r.edits, {}) : undefined,
    deltas: r.deltas ? fromJson<unknown>(r.deltas, null) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqliteTraceStore implements TraceStore {
  constructor(private db: Db) {}

  upsert(trace: NewRunTrace): RunTraceRecord {
    const now = nowIso();
    const existing = this.db.get<TraceRow>('SELECT created_at FROM run_traces WHERE run_id = ?', trace.runId);
    this.db.run(
      `INSERT INTO run_traces (run_id, session_id, user_id, input, seed, steps, parent_run_id, from_step, edits, deltas, created_at, updated_at)
         VALUES (?,?,?,?,?,0,?,?,?,NULL,?,?)
       ON CONFLICT(run_id) DO UPDATE SET
         session_id = excluded.session_id, user_id = excluded.user_id, input = excluded.input,
         seed = excluded.seed, parent_run_id = excluded.parent_run_id, from_step = excluded.from_step,
         edits = excluded.edits, updated_at = excluded.updated_at`,
      trace.runId,
      trace.sessionId ?? null,
      trace.userId ?? null,
      trace.input ?? null,
      toJson(trace.seed ?? {}),
      trace.parentRunId ?? null,
      trace.fromStep ?? null,
      trace.edits ? toJson(trace.edits) : null,
      existing?.created_at ?? now,
      now,
    );
    return this.get(trace.runId)!;
  }

  update(runId: string, patch: Partial<Pick<RunTraceRecord, 'steps' | 'deltas'>>): RunTraceRecord | undefined {
    const existing = this.get(runId);
    if (!existing) return undefined;
    this.db.run(
      'UPDATE run_traces SET steps = ?, deltas = ?, updated_at = ? WHERE run_id = ?',
      patch.steps ?? existing.steps,
      patch.deltas !== undefined ? toJson(patch.deltas) : existing.deltas !== undefined ? toJson(existing.deltas) : null,
      nowIso(),
      runId,
    );
    return this.get(runId);
  }

  get(runId: string): RunTraceRecord | undefined {
    const r = this.db.get<TraceRow>('SELECT * FROM run_traces WHERE run_id = ?', runId);
    return r ? rowToTrace(r) : undefined;
  }

  list(userId?: string, limit = 50): RunTraceRecord[] {
    const rows = userId
      ? this.db.all<TraceRow>('SELECT * FROM run_traces WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      : this.db.all<TraceRow>('SELECT * FROM run_traces ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map(rowToTrace);
  }

  children(runId: string): RunTraceRecord[] {
    return this.db
      .all<TraceRow>('SELECT * FROM run_traces WHERE parent_run_id = ? ORDER BY created_at ASC', runId)
      .map(rowToTrace);
  }

  remove(runId: string): boolean {
    return this.db.run('DELETE FROM run_traces WHERE run_id = ?', runId).changes > 0;
  }

  prune(keep: number): number {
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM run_traces')?.n ?? 0;
    const excess = total - keep;
    if (excess <= 0) return 0;
    const victims = this.db.all<{ run_id: string }>(
      'SELECT run_id FROM run_traces ORDER BY created_at ASC LIMIT ?',
      excess,
    );
    let removed = 0;
    for (const v of victims) removed += this.remove(v.run_id) ? 1 : 0;
    return removed;
  }
}
