/**
 * Offline, deterministic tests for the usage-insights aggregator (Tier-2 gap #8).
 *
 * The heavy logic (aggregateInsights) is pure over injected rows — no DB, no network, no clock. The
 * time-range resolution is tested with a fixed clock. The thin DB query layer is exercised against a real
 * in-memory SQLite Db seeded with the existing `usage` + `runs` schema (the data insights aggregates).
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateInsights,
  resolveInsightsRange,
  queryUsageRows,
  buildInsights,
  formatTokens,
  formatCost,
  Db,
  type UsageRow,
} from '@mercury/core';

const rows: UsageRow[] = [
  { ts: '2026-01-01T10:00:00.000Z', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, cost: 0.10, userId: 'alice', sessionId: 's1' },
  { ts: '2026-01-01T12:00:00.000Z', model: 'gpt-4o-mini', inputTokens: 200, outputTokens: 80, cost: 0.02, userId: 'bob', sessionId: 's2' },
  { ts: '2026-01-02T09:00:00.000Z', model: 'gpt-4o', inputTokens: 300, outputTokens: 120, cost: 0.30, userId: 'alice', sessionId: 's1' },
  { ts: '2026-01-02T15:00:00.000Z', model: 'claude-3', inputTokens: 400, outputTokens: 60, cost: 0.05, userId: 'alice', sessionId: 's3' },
];

describe('aggregateInsights — totals', () => {
  it('sums tokens, cost and calls across all rows', () => {
    const r = aggregateInsights(rows);
    expect(r.totals.calls).toBe(4);
    expect(r.totals.inputTokens).toBe(1000);
    expect(r.totals.outputTokens).toBe(310);
    expect(r.totals.tokens).toBe(1310);
    expect(r.totals.cost).toBeCloseTo(0.47, 10);
    expect(r.firstTs).toBe('2026-01-01T10:00:00.000Z');
    expect(r.lastTs).toBe('2026-01-02T15:00:00.000Z');
    expect(r.empty).toBe(false);
  });
});

describe('aggregateInsights — grouping', () => {
  it('groups by day, chronologically', () => {
    const r = aggregateInsights(rows, { by: 'day' });
    expect(r.buckets.map((b) => b.key)).toEqual(['2026-01-01', '2026-01-02']);
    expect(r.buckets[0]!.calls).toBe(2);
    expect(r.buckets[0]!.cost).toBeCloseTo(0.12, 10);
    expect(r.buckets[1]!.tokens).toBe(880);
  });

  it('groups by model, sorted by cost desc', () => {
    const r = aggregateInsights(rows, { by: 'model' });
    expect(r.buckets.map((b) => b.key)).toEqual(['gpt-4o', 'claude-3', 'gpt-4o-mini']);
    expect(r.buckets[0]!.cost).toBeCloseTo(0.40, 10);
    expect(r.buckets[0]!.calls).toBe(2);
  });

  it('groups by agent (user) and by session', () => {
    const byAgent = aggregateInsights(rows, { by: 'agent' });
    expect(byAgent.buckets.map((b) => b.key)).toEqual(['alice', 'bob']);
    expect(byAgent.buckets[0]!.cost).toBeCloseTo(0.45, 10);
    const bySession = aggregateInsights(rows, { by: 'session' });
    expect(bySession.buckets.map((b) => b.key)).toEqual(['s1', 's3', 's2']);
  });

  it('honours top-N after sorting', () => {
    const r = aggregateInsights(rows, { by: 'model', top: 2 });
    expect(r.buckets.map((b) => b.key)).toEqual(['gpt-4o', 'claude-3']);
  });

  it('labels missing attribution', () => {
    const r = aggregateInsights([{ ts: '2026-03-01T00:00:00Z', model: 'm', inputTokens: 1, outputTokens: 1, cost: 0 }], { by: 'agent' });
    expect(r.buckets[0]!.key).toBe('(unattributed)');
    const s = aggregateInsights([{ ts: '2026-03-01T00:00:00Z', model: 'm', inputTokens: 1, outputTokens: 1, cost: 0 }], { by: 'session' });
    expect(s.buckets[0]!.key).toBe('(no session)');
  });
});

describe('aggregateInsights — empty', () => {
  it('reports empty with zeroed totals', () => {
    const r = aggregateInsights([]);
    expect(r.empty).toBe(true);
    expect(r.totals.calls).toBe(0);
    expect(r.buckets).toEqual([]);
    expect(r.firstTs).toBeUndefined();
  });
});

describe('resolveInsightsRange', () => {
  const now = new Date('2026-02-01T00:00:00.000Z');
  it('resolves a duration relative to the injected clock', () => {
    const { sinceIso } = resolveInsightsRange({ since: '7d' }, now);
    expect(sinceIso).toBe('2026-01-25T00:00:00.000Z');
  });
  it('resolves an ISO date', () => {
    const { sinceIso, untilIso } = resolveInsightsRange({ since: '2026-01-01', until: '2026-01-15' }, now);
    expect(sinceIso).toBe('2026-01-01T00:00:00.000Z');
    expect(untilIso).toBe('2026-01-15T00:00:00.000Z');
  });
  it('returns {} when nothing is given', () => {
    expect(resolveInsightsRange({}, now)).toEqual({});
  });
});

describe('formatting helpers', () => {
  it('formats tokens readably', () => {
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(15000)).toBe('15.0k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
  it('formats cost readably', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0005)).toBe('$0.0005');
    expect(formatCost(0.5)).toBe('$0.500');
    expect(formatCost(12.345)).toBe('$12.35');
  });
});

// ───────────────────────────── DB query layer (real in-memory SQLite) ─────────────────────────────

function seedDb(): Db {
  // The Db constructor auto-runs all migrations, so `usage` + `runs` already exist (the real schema
  // insights aggregates). We only seed rows.
  const db = new Db(':memory:');
  db.run("INSERT INTO runs (id, user_id, session_id, kind, status, started_at) VALUES ('r1','alice','sess-A','chat','ok','2026-01-01T10:00:00Z')");
  db.run("INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, kind, run_id, ts) VALUES ('alice','gpt-4o',100,50,0.10,'chat','r1','2026-01-01T10:00:00Z')");
  db.run("INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, kind, run_id, ts) VALUES ('alice','gpt-4o',300,120,0.30,'chat','r1','2026-01-02T09:00:00Z')");
  db.run("INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, kind, run_id, ts) VALUES ('bob','mini',10,5,0.001,'chat',NULL,'2026-01-03T09:00:00Z')");
  return db;
}

describe('queryUsageRows / buildInsights (DB)', () => {
  it('reads rows joined to runs for session context', () => {
    const db = seedDb();
    const got = queryUsageRows(db);
    expect(got.length).toBe(3);
    const a1 = got.find((r) => r.cost === 0.10)!;
    expect(a1.sessionId).toBe('sess-A');
    const noRun = got.find((r) => r.userId === 'bob')!;
    expect(noRun.sessionId).toBeUndefined();
    db.close();
  });

  it('applies since/until/limit filters', () => {
    const db = seedDb();
    expect(queryUsageRows(db, { sinceIso: '2026-01-02T00:00:00Z' }).length).toBe(2);
    expect(queryUsageRows(db, { untilIso: '2026-01-02T00:00:00Z' }).length).toBe(1);
    expect(queryUsageRows(db, { limit: 1 }).length).toBe(1);
    db.close();
  });

  it('buildInsights aggregates DB rows by model', () => {
    const db = seedDb();
    const r = buildInsights(db, { by: 'model' });
    expect(r.totals.calls).toBe(3);
    expect(r.buckets[0]!.key).toBe('gpt-4o');
    expect(r.buckets[0]!.cost).toBeCloseTo(0.40, 10);
    db.close();
  });

  it('buildInsights on an empty DB reports empty', () => {
    const db = new Db(':memory:'); // migrated but unseeded
    const r = buildInsights(db);
    expect(r.empty).toBe(true);
    expect(r.totals.calls).toBe(0);
    db.close();
  });
});
