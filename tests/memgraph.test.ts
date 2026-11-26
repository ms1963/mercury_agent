/**
 * Offline, deterministic tests for the memory graph & journey timeline (Tier-3 gap #11).
 *
 * The heavy logic (buildMemGraph, memGraphToDot, journeyEventsFrom, buildJourneyTimeline) is PURE over
 * injected rows — no DB, no network, no clock. Range resolution is tested with a fixed clock. The thin
 * DB read layer is exercised against a real in-memory SQLite Db seeded with the existing schema the
 * views read from (facts / distilled_skills / runs / sessions / knowledge / reflections).
 */
import { describe, it, expect } from 'vitest';
import {
  buildMemGraph,
  memGraphToDot,
  journeyEventsFrom,
  buildJourneyTimeline,
  resolveJourneyRange,
  queryMemGraphInput,
  buildMemGraphFromDb,
  queryJourneyEvents,
  buildJourney,
  Db,
  type MemGraphInput,
  type JourneyEvent,
} from '@mercury/core';

// ───────────────────────────── graph: pure construction ─────────────────────────────

const graphInput: MemGraphInput = {
  facts: [
    { id: 'f1', kind: 'fact', scope: 'global', namespace: 'default', content: 'The user prefers dark mode', source: 'r1', createdAt: '2026-01-01T10:00:00.000Z' },
    { id: 'f2', kind: 'lesson', content: 'Always confirm before deleting', source: 'nope-not-an-id', createdAt: '2026-01-02T10:00:00.000Z' },
  ],
  skills: [
    { id: 'sk1', name: 'deploy-flow', status: 'approved', sourceRuns: ['r1', 'r2'], createdAt: '2026-01-03T10:00:00.000Z' },
    { id: 'sk2', name: 'orphan-skill', status: 'pending', sourceRuns: ['missing-run'], createdAt: '2026-01-03T11:00:00.000Z' },
  ],
  runs: [
    { id: 'r1', sessionId: 'sess1', kind: 'chat', status: 'ok', startedAt: '2026-01-01T09:00:00.000Z' },
    { id: 'r2', sessionId: 'sess1', parentRunId: 'r1', kind: 'tool', status: 'ok', startedAt: '2026-01-01T09:05:00.000Z' },
  ],
  sessions: [{ id: 'sess1', title: 'Setting up CI', createdAt: '2026-01-01T08:00:00.000Z' }],
  knowledge: [{ sourceId: 'src1', title: 'Runbook', chunks: 4, createdAt: '2026-01-02T08:00:00.000Z' }],
};

describe('buildMemGraph — nodes', () => {
  it('creates one node per memory entity, prefixed by kind', () => {
    const g = buildMemGraph(graphInput);
    expect(g.summary.nodeCount).toBe(2 + 2 + 2 + 1 + 1); // facts+skills+runs+session+knowledge = 8
    expect(g.summary.nodesByKind).toEqual({ fact: 2, skill: 2, run: 2, session: 1, knowledge: 1 });
    expect(g.nodes.find((n) => n.id === 'fact:f1')?.label).toContain('dark mode');
    expect(g.nodes.find((n) => n.id === 'run:r1')?.label).toBe('chat (ok)');
    expect(g.nodes.find((n) => n.id === 'knowledge:src1')?.meta?.chunks).toBe(4);
  });
});

describe('buildMemGraph — grounded edges', () => {
  it('emits distilled_from, in_session, spawned and sourced_from only when both endpoints exist', () => {
    const g = buildMemGraph(graphInput);
    const has = (from: string, rel: string, to: string): boolean => g.edges.some((e) => e.from === from && e.rel === rel && e.to === to);
    // skill distilled from an existing run
    expect(has('skill:sk1', 'distilled_from', 'run:r1')).toBe(true);
    expect(has('skill:sk1', 'distilled_from', 'run:r2')).toBe(true);
    // runs in a session
    expect(has('run:r1', 'in_session', 'session:sess1')).toBe(true);
    // parent → child spawn
    expect(has('run:r1', 'spawned', 'run:r2')).toBe(true);
    // fact sourced from a run (f1.source === 'r1')
    expect(has('fact:f1', 'sourced_from', 'run:r1')).toBe(true);
    expect(g.summary.edgesByRel).toEqual({ distilled_from: 2, in_session: 2, spawned: 1, sourced_from: 1 });
  });

  it('drops edges whose endpoint is not in the node set (no invented edges)', () => {
    const g = buildMemGraph(graphInput);
    // sk2 references a run that does not exist → no edge
    expect(g.edges.some((e) => e.from === 'skill:sk2')).toBe(false);
    // f2.source is not an id → no sourced_from edge
    expect(g.edges.some((e) => e.from === 'fact:f2')).toBe(false);
  });

  it('computes top-connected nodes by degree', () => {
    const g = buildMemGraph(graphInput, { top: 3 });
    expect(g.summary.topConnected.length).toBeLessThanOrEqual(3);
    // r1 has the most connections: in_session(1) + spawned(1) + distilled_from(1) + sourced_from(1) = 4
    expect(g.summary.topConnected[0]?.id).toBe('run:r1');
    expect(g.summary.topConnected[0]?.degree).toBe(4);
  });
});

describe('buildMemGraph — empty', () => {
  it('reports empty for no input', () => {
    const g = buildMemGraph({});
    expect(g.summary.empty).toBe(true);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe('memGraphToDot', () => {
  it('emits a valid, deterministic Graphviz digraph', () => {
    const g = buildMemGraph(graphInput);
    const dot = memGraphToDot(g);
    expect(dot.startsWith('digraph mercury_memory {')).toBe(true);
    expect(dot.trimEnd().endsWith('}')).toBe(true);
    expect(dot).toContain('"skill:sk1" -> "run:r1" [label="distilled_from"];');
    expect(dot).toContain('"run:r1" -> "session:sess1" [label="in_session"];');
    // deterministic: same input → identical output
    expect(memGraphToDot(buildMemGraph(graphInput))).toBe(dot);
  });

  it('escapes quotes/backslashes in labels', () => {
    const g = buildMemGraph({ facts: [{ id: 'f', kind: 'fact', content: 'say "hi" \\ ok', createdAt: '2026-01-01T00:00:00.000Z' }] });
    const dot = memGraphToDot(g);
    expect(dot).toContain('\\"hi\\"');
    expect(dot).toContain('\\\\');
  });
});

// ───────────────────────────── timeline: pure ─────────────────────────────

const events: JourneyEvent[] = journeyEventsFrom({
  facts: [{ id: 'f1', kind: 'fact', content: 'remember this', createdAt: '2026-01-02T10:00:00.000Z' }],
  skills: [{ id: 'sk1', name: 'deploy', status: 'approved', sourceRuns: ['r1'], createdAt: '2026-01-05T10:00:00.000Z' }],
  knowledge: [{ sourceId: 'src1', title: 'Doc', chunks: 3, createdAt: '2026-01-03T10:00:00.000Z' }],
  runs: [{ id: 'r1', kind: 'chat', status: 'ok', startedAt: '2026-01-01T10:00:00.000Z' }],
  reflections: [{ id: 'ref1', runId: 'r1', skill: 'deploy', verdict: 'success', score: 0.9, createdAt: '2026-01-04T10:00:00.000Z' }],
  sessions: [{ id: 'sess1', title: 'chat', createdAt: '2026-01-01T09:00:00.000Z' }],
});

describe('journeyEventsFrom + buildJourneyTimeline', () => {
  it('maps each row kind to a timeline event', () => {
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['memory', 'skill', 'knowledge', 'run', 'learn', 'session']));
  });

  it('orders events newest-first', () => {
    const t = buildJourneyTimeline(events);
    const ts = t.events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort().reverse());
    expect(t.events[0]?.kind).toBe('skill'); // 2026-01-05 is latest
    expect(t.total).toBe(6);
    expect(t.empty).toBe(false);
  });

  it('filters by --since/--until range (exclusive upper bound)', () => {
    const t = buildJourneyTimeline(events, { sinceIso: '2026-01-02T00:00:00.000Z', untilIso: '2026-01-05T00:00:00.000Z' });
    // keeps 2026-01-02 (memory), 01-03 (knowledge), 01-04 (learn) — excludes 01-01 runs/session and 01-05 skill
    expect(t.total).toBe(3);
    expect(t.events.map((e) => e.kind)).toEqual(['learn', 'knowledge', 'memory']);
  });

  it('applies --limit after range filtering (counts reflect full range)', () => {
    const t = buildJourneyTimeline(events, { limit: 2 });
    expect(t.events.length).toBe(2);
    expect(t.total).toBe(6); // total is the pre-limit count
    expect(t.counts.skill).toBe(1);
  });

  it('filters by kind', () => {
    const t = buildJourneyTimeline(events, { kinds: ['memory', 'skill'] });
    expect(t.total).toBe(2);
    expect(new Set(t.events.map((e) => e.kind))).toEqual(new Set(['memory', 'skill']));
  });

  it('reports empty for no events', () => {
    const t = buildJourneyTimeline([]);
    expect(t.empty).toBe(true);
    expect(t.events).toEqual([]);
    expect(t.total).toBe(0);
  });
});

describe('resolveJourneyRange', () => {
  it('resolves a duration and an ISO date against an injected clock', () => {
    const now = new Date('2026-01-10T00:00:00.000Z');
    const r = resolveJourneyRange({ since: '3d', until: '2026-01-09' }, now);
    expect(r.sinceIso).toBe('2026-01-07T00:00:00.000Z');
    expect(r.untilIso).toBe('2026-01-09T00:00:00.000Z');
  });

  it('returns {} when nothing is specified', () => {
    expect(resolveJourneyRange({}, new Date())).toEqual({});
  });
});

// ───────────────────────────── DB read layer (integration, :memory:) ─────────────────────────────

function seed(db: Db): void {
  db.run("INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES ('sess1','alice','Setup',  '2026-01-01T08:00:00Z','2026-01-01T08:00:00Z')");
  db.run("INSERT INTO runs (id, user_id, session_id, parent_run_id, kind, status, started_at) VALUES ('r1','alice','sess1',NULL,'chat','ok','2026-01-01T09:00:00Z')");
  db.run("INSERT INTO runs (id, user_id, session_id, parent_run_id, kind, status, started_at) VALUES ('r2','alice','sess1','r1','tool','ok','2026-01-01T09:05:00Z')");
  db.run("INSERT INTO facts (id, user_id, scope, namespace, kind, content, importance, source, created_at, updated_at) VALUES ('f1','alice','global','default','fact','prefers dark mode',0.5,'r1','2026-01-02T10:00:00Z','2026-01-02T10:00:00Z')");
  db.run("INSERT INTO distilled_skills (id, name, trigger, params, steps, version, status, source_runs, created_at, updated_at) VALUES ('sk1','deploy','deploy','[]','[]',1,'approved','[\"r1\",\"r2\"]','2026-01-03T10:00:00Z','2026-01-03T10:00:00Z')");
  db.run("INSERT INTO knowledge (id, user_id, namespace, source_id, title, content, created_at, updated_at) VALUES ('k1','alice','default','src1','Runbook','chunk a','2026-01-02T08:00:00Z','2026-01-02T08:00:00Z')");
  db.run("INSERT INTO knowledge (id, user_id, namespace, source_id, title, content, created_at, updated_at) VALUES ('k2','alice','default','src1','Runbook','chunk b','2026-01-02T08:01:00Z','2026-01-02T08:01:00Z')");
  db.run("INSERT INTO reflections (id, run_id, user_id, session_id, score, verdict, lessons, skill, created_at) VALUES ('ref1','r1','alice','sess1',0.9,'success','[]','deploy','2026-01-04T10:00:00Z')");
}

describe('queryMemGraphInput + buildMemGraphFromDb (DB)', () => {
  it('reads existing rows and builds the graph with grounded edges', () => {
    const db = new Db(':memory:');
    seed(db);
    const input = queryMemGraphInput(db);
    expect(input.facts?.length).toBe(1);
    expect(input.skills?.[0]?.sourceRuns).toEqual(['r1', 'r2']);
    expect(input.knowledge).toEqual([{ sourceId: 'src1', title: 'Runbook', chunks: 2, createdAt: '2026-01-02T08:00:00Z' }]);

    const g = buildMemGraphFromDb(db);
    expect(g.summary.nodesByKind).toEqual({ fact: 1, skill: 1, run: 2, session: 1, knowledge: 1 });
    expect(g.edges.some((e) => e.from === 'skill:sk1' && e.rel === 'distilled_from' && e.to === 'run:r1')).toBe(true);
    expect(g.edges.some((e) => e.from === 'fact:f1' && e.rel === 'sourced_from' && e.to === 'run:r1')).toBe(true);
    db.close();
  });

  it('empty DB yields an empty graph', () => {
    const db = new Db(':memory:');
    expect(buildMemGraphFromDb(db).summary.empty).toBe(true);
    db.close();
  });
});

describe('queryJourneyEvents + buildJourney (DB)', () => {
  it('assembles a timeline from all existing event sources', () => {
    const db = new Db(':memory:');
    seed(db);
    const evs = queryJourneyEvents(db);
    expect(new Set(evs.map((e) => e.kind))).toEqual(new Set(['memory', 'skill', 'knowledge', 'run', 'learn', 'session']));

    const t = buildJourney(db);
    expect(t.total).toBe(evs.length);
    expect(t.events[0]?.ts >= (t.events[t.events.length - 1]?.ts ?? '')).toBe(true); // newest first
    db.close();
  });

  it('empty DB yields an empty timeline', () => {
    const db = new Db(':memory:');
    expect(buildJourney(db).empty).toBe(true);
    db.close();
  });
});
