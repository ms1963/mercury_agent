/**
 * Usage insights (Tier-2 gap #8) — a pure, read-only analytics view over data Mercury **already
 * records**. It aggregates the token/cost ledger (the `usage` table, written by
 * {@link ../budgets/budgets.js | BudgetService.record}) joined to the `runs` table for session context.
 *
 * This module adds NO instrumentation and NO schema. It only reads existing rows:
 *   - `usage(user_id, model, input_tokens, output_tokens, cost, kind, run_id, ts)` — the token/cost ledger
 *   - `runs(id, session_id, user_id, ...)` — to attribute a usage row to a session ("agent/session")
 *
 * The heavy logic is PURE over injected {@link UsageRow} arrays ({@link aggregateInsights}), so it is
 * fully unit-testable with no DB and no clock. A thin query layer ({@link queryUsageRows}) only fetches
 * rows read-only from an existing {@link Db}; {@link buildInsights} glues them together.
 *
 * Exported generic names are prefixed (`Insights*` / `*Insights`) to avoid barrel collisions with the
 * projects / profiles / sessions modules.
 */
import type { Db } from '../db/db.js';
import { parseCutoff } from '../sessions/manage.js';

/** One ledger row as consumed by the pure aggregator (a subset of the `usage` table + joined session). */
export interface UsageRow {
  /** ISO timestamp the usage was recorded at (`usage.ts`). */
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** `usage.kind` (e.g. `chat`, `decision`); defaults to `chat`. */
  kind?: string;
  /** `usage.user_id` — the acting principal (used for the `agent` grouping). */
  userId?: string;
  /** `runs.session_id` for this row's `run_id`, when joinable (used for the `session` grouping). */
  sessionId?: string;
}

/** The grouping dimension for a breakdown. */
export type InsightsGroupBy = 'day' | 'model' | 'agent' | 'session';

/** Aggregated totals shared by the whole report and by each breakdown bucket. */
export interface InsightsTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  calls: number;
}

/** One bucket of a grouped breakdown. */
export interface InsightsBucket extends InsightsTotals {
  /** The bucket key: a day (`YYYY-MM-DD`), model name, agent/user id, or session id. */
  key: string;
}

/** Options controlling {@link aggregateInsights}. */
export interface InsightsOptions {
  by?: InsightsGroupBy;
  /** Keep only the top-N buckets (by cost, then tokens). 0/undefined = all. */
  top?: number;
}

/** The full aggregated report produced by {@link aggregateInsights}. */
export interface InsightsReport {
  totals: InsightsTotals;
  by: InsightsGroupBy;
  /** Breakdown buckets, sorted (day → chronological; others → cost desc then key). */
  buckets: InsightsBucket[];
  /** Earliest / latest `ts` observed (ISO), or undefined when there are no rows. */
  firstTs?: string;
  lastTs?: string;
  /** True when no usage rows were aggregated. */
  empty: boolean;
}

const zeroTotals = (): InsightsTotals => ({ inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0, calls: 0 });

function addRow(acc: InsightsTotals, row: UsageRow): void {
  const inp = row.inputTokens || 0;
  const out = row.outputTokens || 0;
  acc.inputTokens += inp;
  acc.outputTokens += out;
  acc.tokens += inp + out;
  acc.cost += row.cost || 0;
  acc.calls += 1;
}

/** The bucket key for a row under a given grouping (pure). */
function keyOf(row: UsageRow, by: InsightsGroupBy): string {
  switch (by) {
    case 'day':
      return (row.ts || '').slice(0, 10) || '(unknown)';
    case 'model':
      return row.model || '(unknown)';
    case 'agent':
      return row.userId || '(unattributed)';
    case 'session':
      return row.sessionId || '(no session)';
  }
}

/**
 * Aggregate ledger rows into totals + a grouped breakdown (PURE — no fs, no DB, no clock). Buckets are
 * sorted chronologically for `day` and by cost (desc), then key, for every other grouping; `top` keeps
 * only the first N buckets after sorting.
 */
export function aggregateInsights(rows: UsageRow[], opts: InsightsOptions = {}): InsightsReport {
  const by = opts.by ?? 'day';
  const totals = zeroTotals();
  const map = new Map<string, InsightsBucket>();
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const row of rows) {
    addRow(totals, row);
    if (row.ts) {
      if (firstTs === undefined || row.ts < firstTs) firstTs = row.ts;
      if (lastTs === undefined || row.ts > lastTs) lastTs = row.ts;
    }
    const key = keyOf(row, by);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, ...zeroTotals() };
      map.set(key, bucket);
    }
    addRow(bucket, row);
  }

  let buckets = [...map.values()];
  if (by === 'day') {
    buckets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } else {
    buckets.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  if (opts.top && opts.top > 0) buckets = buckets.slice(0, opts.top);

  return { totals, by, buckets, firstTs, lastTs, empty: rows.length === 0 };
}

// ───────────────────────────── formatting helpers (pure) ─────────────────────────────

/** Format a token count readably (`1234` → `1,234`; `1_200_000` → `1.2M`). */
export function formatTokens(n: number): string {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString('en-US');
}

/** Format a cost in USD readably (small values keep more precision). */
export function formatCost(n: number): string {
  const v = n || 0;
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

// ───────────────────────────── thin DB query layer (read-only) ─────────────────────────────

/** Time-range filter for {@link queryUsageRows} / {@link buildInsights}. */
export interface InsightsRange {
  /** Inclusive lower bound (ISO). */
  sinceIso?: string;
  /** Exclusive upper bound (ISO). */
  untilIso?: string;
  /** Limit the number of ledger rows read (most-recent first); 0/undefined = all. */
  limit?: number;
}

/**
 * Resolve `--since` / `--until` (a duration like `30d`/`12h` or an ISO date) to ISO bounds, using an
 * injected clock for determinism. Returns `{}` when neither is given.
 */
export function resolveInsightsRange(
  spec: { since?: string; until?: string } = {},
  now: Date = new Date(),
): { sinceIso?: string; untilIso?: string } {
  const out: { sinceIso?: string; untilIso?: string } = {};
  if (spec.since) out.sinceIso = parseCutoff(spec.since, now).toISOString();
  if (spec.until) out.untilIso = parseCutoff(spec.until, now).toISOString();
  return out;
}

/** Read usage-ledger rows (joined to runs for session context) from an existing DB, read-only. */
export function queryUsageRows(db: Db, range: InsightsRange = {}): UsageRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (range.sinceIso) {
    where.push('u.ts >= ?');
    params.push(range.sinceIso);
  }
  if (range.untilIso) {
    where.push('u.ts < ?');
    params.push(range.untilIso);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = range.limit && range.limit > 0 ? `LIMIT ${Math.floor(range.limit)}` : '';
  const sql = `SELECT u.ts ts, u.model model, u.input_tokens inputTokens, u.output_tokens outputTokens,
      u.cost cost, u.kind kind, u.user_id userId, r.session_id sessionId
    FROM usage u LEFT JOIN runs r ON r.id = u.run_id
    ${whereSql} ORDER BY u.ts DESC ${limitSql}`;
  const raw = db.all<{
    ts: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    kind: string | null;
    userId: string | null;
    sessionId: string | null;
  }>(sql, ...params);
  return raw.map((r) => ({
    ts: r.ts,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cost: r.cost,
    kind: r.kind ?? undefined,
    userId: r.userId ?? undefined,
    sessionId: r.sessionId ?? undefined,
  }));
}

/** Fetch + aggregate in one call: read ledger rows for the range, then aggregate by the given grouping. */
export function buildInsights(
  db: Db,
  opts: { range?: InsightsRange; by?: InsightsGroupBy; top?: number } = {},
): InsightsReport {
  const rows = queryUsageRows(db, opts.range ?? {});
  return aggregateInsights(rows, { by: opts.by, top: opts.top });
}
