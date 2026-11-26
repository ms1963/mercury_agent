/**
 * Memory graph & journey timeline (Tier-3 gap #11) — two pure, **read-only** views over data
 * Mercury **already records**. This module adds NO instrumentation and NO schema: it only reads
 * existing rows and projects them into (a) a graph of memory entities and their real stored
 * relationships, and (b) a chronological timeline of significant events.
 *
 * What it reads (all existing tables — see {@link ../db/migrations.js}):
 *   - `facts`            — semantic memory items  (id, kind, scope, namespace, content, source, created_at)
 *   - `distilled_skills` — procedural skills distilled from winning runs (id, name, status, source_runs, created_at)
 *   - `runs`            — agent runs (id, session_id, parent_run_id, kind, status, started_at)
 *   - `sessions`        — episodic sessions (id, title, created_at)
 *   - `knowledge`       — ingested RAG sources, grouped by source (source_id, title, chunk count, first created_at)
 *   - `reflections`     — post-run reflections / `learn` outcomes (id, run_id, skill, verdict, score, created_at)
 *
 * ## Edge semantics (grounded — NO invented edges)
 * Every edge is backed by a real stored column; an edge is only emitted when BOTH endpoints exist in
 * the node set (a reference to a row outside the current view is dropped rather than fabricated):
 *   - `skill  --distilled_from--> run`     ← `distilled_skills.source_runs[]` (the winning run traces a skill was distilled from)
 *   - `run    --in_session-----> session`  ← `runs.session_id`
 *   - `run    --spawned--------> run`       ← `runs.parent_run_id` (parent → child; sub-agent / fork lineage)
 *   - `fact   --sourced_from---> run|session` ← `facts.source` **only when** it exactly equals a known run or session id
 *
 * Reflections are surfaced in the TIMELINE (as `learn` events) but NOT as graph edges — their `skill`
 * column is a free-text name, not a stored id, so turning it into a graph edge would be guesswork.
 *
 * The heavy logic is PURE over injected rows ({@link buildMemGraph}, {@link buildJourneyTimeline},
 * {@link memGraphToDot}), fully unit-testable with no DB and an injected clock. A thin query layer
 * ({@link queryMemGraphInput}, {@link queryJourneyEvents}) only reads rows read-only from an existing
 * {@link Db}; {@link buildMemGraphFromDb} / {@link buildJourney} glue them together.
 *
 * Exported names are prefixed (`MemGraph*` / `Journey*`) to avoid barrel collisions.
 */
import type { Db } from '../db/db.js';
import { fromJson } from '../db/db.js';
import { parseCutoff } from '../sessions/manage.js';

// ───────────────────────────── graph: injected row shapes ─────────────────────────────

/** A semantic-memory item (subset of the `facts` table). */
export interface MemFactRow {
  id: string;
  kind: string;
  scope?: string;
  namespace?: string;
  content: string;
  /** Free-text provenance; when it equals a run/session id it becomes a `sourced_from` edge. */
  source?: string;
  createdAt: string;
}
/** A distilled skill (subset of `distilled_skills`). `sourceRuns` are the run ids it was distilled from. */
export interface MemSkillRow {
  id: string;
  name: string;
  status: string;
  sourceRuns: string[];
  createdAt: string;
}
/** An agent run (subset of `runs`). */
export interface MemRunRow {
  id: string;
  sessionId?: string;
  parentRunId?: string;
  kind: string;
  status: string;
  startedAt: string;
}
/** An episodic session (subset of `sessions`). */
export interface MemSessionRow {
  id: string;
  title?: string;
  createdAt: string;
}
/** An ingested knowledge source, pre-grouped by `source_id` (count of chunks, earliest created_at). */
export interface MemKnowledgeRow {
  sourceId: string;
  title?: string;
  chunks: number;
  createdAt: string;
}
/** A post-run reflection / `learn` outcome (subset of `reflections`) — timeline only. */
export interface MemReflectionRow {
  id: string;
  runId?: string;
  skill?: string;
  verdict?: string;
  score?: number;
  createdAt: string;
}

/** The full set of injected rows the graph is built from. All arrays are optional (default empty). */
export interface MemGraphInput {
  facts?: MemFactRow[];
  skills?: MemSkillRow[];
  runs?: MemRunRow[];
  sessions?: MemSessionRow[];
  knowledge?: MemKnowledgeRow[];
}

// ───────────────────────────── graph: output shapes ─────────────────────────────

export type MemGraphNodeKind = 'fact' | 'skill' | 'run' | 'session' | 'knowledge';
export type MemGraphEdgeRel = 'distilled_from' | 'in_session' | 'spawned' | 'sourced_from';

/** A graph node. `id` is prefixed by kind (`fact:…`, `run:…`) so ids never collide across kinds. */
export interface MemGraphNode {
  id: string;
  kind: MemGraphNodeKind;
  label: string;
  ts?: string;
  meta?: Record<string, string | number>;
}
/** A directed, grounded edge between two existing nodes. */
export interface MemGraphEdge {
  from: string;
  to: string;
  rel: MemGraphEdgeRel;
}
/** A node annotated with its (undirected) connection count — used for the "top connected" summary. */
export interface MemGraphNodeDegree {
  id: string;
  label: string;
  kind: MemGraphNodeKind;
  degree: number;
}

const NODE_KINDS: MemGraphNodeKind[] = ['fact', 'skill', 'run', 'session', 'knowledge'];
const EDGE_RELS: MemGraphEdgeRel[] = ['distilled_from', 'in_session', 'spawned', 'sourced_from'];

/** The computed graph plus a readable summary. */
export interface MemGraph {
  nodes: MemGraphNode[];
  edges: MemGraphEdge[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    nodesByKind: Record<MemGraphNodeKind, number>;
    edgesByRel: Record<MemGraphEdgeRel, number>;
    /** Nodes with the most connections, degree desc then id asc. */
    topConnected: MemGraphNodeDegree[];
    empty: boolean;
  };
}

/** Options controlling {@link buildMemGraph}. */
export interface MemGraphOptions {
  /** How many "top connected" nodes to include in the summary (default 10). */
  top?: number;
}

const nid = (kind: MemGraphNodeKind, id: string): string => `${kind}:${id}`;

/** Collapse whitespace and clip a label to a readable length (pure). */
function clip(s: string, n = 48): string {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * Build a memory graph from injected rows (PURE — no fs, no DB, no clock). Nodes are the memory
 * entities; edges are grounded in real stored columns and only emitted when BOTH endpoints are
 * present (see the module doc for exact edge semantics). Duplicate edges are de-duplicated.
 */
export function buildMemGraph(input: MemGraphInput, opts: MemGraphOptions = {}): MemGraph {
  const facts = input.facts ?? [];
  const skills = input.skills ?? [];
  const runs = input.runs ?? [];
  const sessions = input.sessions ?? [];
  const knowledge = input.knowledge ?? [];

  const nodes = new Map<string, MemGraphNode>();
  const addNode = (n: MemGraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  for (const f of facts) {
    addNode({
      id: nid('fact', f.id),
      kind: 'fact',
      label: clip(f.content) || `(${f.kind})`,
      ts: f.createdAt,
      meta: { kind: f.kind, scope: f.scope ?? 'global', namespace: f.namespace ?? 'default' },
    });
  }
  for (const s of skills) {
    addNode({ id: nid('skill', s.id), kind: 'skill', label: s.name, ts: s.createdAt, meta: { status: s.status } });
  }
  for (const r of runs) {
    addNode({ id: nid('run', r.id), kind: 'run', label: `${r.kind} (${r.status})`, ts: r.startedAt, meta: { kind: r.kind, status: r.status } });
  }
  for (const s of sessions) {
    addNode({ id: nid('session', s.id), kind: 'session', label: clip(s.title || s.id, 40), ts: s.createdAt });
  }
  for (const k of knowledge) {
    addNode({ id: nid('knowledge', k.sourceId), kind: 'knowledge', label: clip(k.title || k.sourceId, 40), ts: k.createdAt, meta: { chunks: k.chunks } });
  }

  const edges: MemGraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, rel: MemGraphEdgeRel): void => {
    if (!nodes.has(from) || !nodes.has(to) || from === to) return; // grounded: both endpoints must exist
    const key = `${from}|${rel}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, rel });
  };

  // skill --distilled_from--> run
  for (const s of skills) {
    for (const runId of s.sourceRuns ?? []) addEdge(nid('skill', s.id), nid('run', runId), 'distilled_from');
  }
  // run --in_session--> session ; run --spawned--> run (parent → child)
  for (const r of runs) {
    if (r.sessionId) addEdge(nid('run', r.id), nid('session', r.sessionId), 'in_session');
    if (r.parentRunId) addEdge(nid('run', r.parentRunId), nid('run', r.id), 'spawned');
  }
  // fact --sourced_from--> run|session (only when facts.source equals a known id)
  for (const f of facts) {
    if (!f.source) continue;
    if (nodes.has(nid('run', f.source))) addEdge(nid('fact', f.id), nid('run', f.source), 'sourced_from');
    else if (nodes.has(nid('session', f.source))) addEdge(nid('fact', f.id), nid('session', f.source), 'sourced_from');
  }

  // summary
  const nodesByKind = Object.fromEntries(NODE_KINDS.map((k) => [k, 0])) as Record<MemGraphNodeKind, number>;
  for (const n of nodes.values()) nodesByKind[n.kind] += 1;
  const edgesByRel = Object.fromEntries(EDGE_RELS.map((r) => [r, 0])) as Record<MemGraphEdgeRel, number>;
  for (const e of edges) edgesByRel[e.rel] += 1;

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const top = opts.top && opts.top > 0 ? opts.top : 10;
  const topConnected: MemGraphNodeDegree[] = [...nodes.values()]
    .map((n) => ({ id: n.id, label: n.label, kind: n.kind, degree: degree.get(n.id) ?? 0 }))
    .filter((d) => d.degree > 0)
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, top);

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edgeList = [...edges].sort(
    (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );

  return {
    nodes: nodeList,
    edges: edgeList,
    summary: { nodeCount: nodeList.length, edgeCount: edgeList.length, nodesByKind, edgesByRel, topConnected, empty: nodeList.length === 0 },
  };
}

// ───────────────────────────── graph: Graphviz DOT export (pure) ─────────────────────────────

const DOT_SHAPE: Record<MemGraphNodeKind, string> = {
  fact: 'box',
  skill: 'component',
  run: 'ellipse',
  session: 'folder',
  knowledge: 'note',
};

const dotEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Render a {@link MemGraph} as a standard Graphviz DOT document (PURE). Node shapes encode the node
 * kind; edge labels encode the relationship. Deterministic ordering (nodes/edges are already sorted).
 */
export function memGraphToDot(graph: MemGraph): string {
  const lines: string[] = ['digraph mercury_memory {', '  rankdir=LR;', '  node [style=filled, fillcolor="#f5f5f5", fontname="Helvetica"];'];
  for (const n of graph.nodes) {
    lines.push(`  "${dotEscape(n.id)}" [label="${dotEscape(n.label)}", shape=${DOT_SHAPE[n.kind]}];`);
  }
  for (const e of graph.edges) {
    lines.push(`  "${dotEscape(e.from)}" -> "${dotEscape(e.to)}" [label="${e.rel}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

// ───────────────────────────── journey timeline (pure) ─────────────────────────────

/** Timeline event categories (memory formation, skill distillation, knowledge ingest, run, learn, session). */
export type JourneyEventKind = 'memory' | 'skill' | 'knowledge' | 'run' | 'learn' | 'session';

/** One significant event on the journey timeline. */
export interface JourneyEvent {
  ts: string;
  kind: JourneyEventKind;
  /** The underlying row id (e.g. `fact_…`, `skill_…`, a run id). */
  id: string;
  /** A short readable headline. */
  title: string;
  /** Optional longer detail. */
  detail?: string;
  meta?: Record<string, string | number>;
}

/** Options for {@link buildJourneyTimeline}. */
export interface JourneyOptions {
  /** Inclusive lower bound (ISO). */
  sinceIso?: string;
  /** Exclusive upper bound (ISO). */
  untilIso?: string;
  /** Keep only the most-recent N events (after range filtering). 0/undefined = all. */
  limit?: number;
  /** Restrict to these event kinds. */
  kinds?: JourneyEventKind[];
}

/** The computed timeline plus a small summary. */
export interface JourneyTimeline {
  /** Events, newest first. */
  events: JourneyEvent[];
  /** Count per kind across the range (before `limit`). */
  counts: Record<JourneyEventKind, number>;
  /** Total matching events in range (before `limit`). */
  total: number;
  firstTs?: string;
  lastTs?: string;
  empty: boolean;
}

const JOURNEY_KINDS: JourneyEventKind[] = ['memory', 'skill', 'knowledge', 'run', 'learn', 'session'];

/** Convert injected rows into un-sorted, un-filtered journey events (PURE). */
export function journeyEventsFrom(input: {
  facts?: MemFactRow[];
  skills?: MemSkillRow[];
  knowledge?: MemKnowledgeRow[];
  runs?: MemRunRow[];
  reflections?: MemReflectionRow[];
  sessions?: MemSessionRow[];
}): JourneyEvent[] {
  const events: JourneyEvent[] = [];
  for (const f of input.facts ?? []) {
    events.push({ ts: f.createdAt, kind: 'memory', id: f.id, title: `Remembered ${f.kind}: ${clip(f.content, 60)}`, meta: { kind: f.kind, namespace: f.namespace ?? 'default' } });
  }
  for (const s of input.skills ?? []) {
    events.push({ ts: s.createdAt, kind: 'skill', id: s.id, title: `Distilled skill "${s.name}" (${s.status})`, meta: { status: s.status, sourceRuns: (s.sourceRuns ?? []).length } });
  }
  for (const k of input.knowledge ?? []) {
    events.push({ ts: k.createdAt, kind: 'knowledge', id: k.sourceId, title: `Ingested source ${clip(k.title || k.sourceId, 50)}`, meta: { chunks: k.chunks } });
  }
  for (const r of input.runs ?? []) {
    events.push({ ts: r.startedAt, kind: 'run', id: r.id, title: `Run ${r.kind} — ${r.status}`, meta: { kind: r.kind, status: r.status } });
  }
  for (const rf of input.reflections ?? []) {
    const verdict = rf.verdict ?? 'reflected';
    const score = typeof rf.score === 'number' ? ` (score ${rf.score})` : '';
    events.push({ ts: rf.createdAt, kind: 'learn', id: rf.id, title: `Learned: ${verdict}${score}${rf.skill ? ` → ${rf.skill}` : ''}`, meta: rf.skill ? { skill: rf.skill } : {} });
  }
  for (const s of input.sessions ?? []) {
    events.push({ ts: s.createdAt, kind: 'session', id: s.id, title: `Session started: ${clip(s.title || s.id, 50)}` });
  }
  return events;
}

/**
 * Sort, range-filter and limit journey events (PURE — no fs, no DB, no clock). Events are returned
 * newest-first; `counts`, `total` and `firstTs`/`lastTs` reflect the range-filtered set BEFORE `limit`.
 */
export function buildJourneyTimeline(events: JourneyEvent[], opts: JourneyOptions = {}): JourneyTimeline {
  const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : undefined;
  const filtered = events.filter((e) => {
    if (kinds && !kinds.has(e.kind)) return false;
    if (opts.sinceIso && e.ts < opts.sinceIso) return false;
    if (opts.untilIso && e.ts >= opts.untilIso) return false;
    return true;
  });
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // newest first

  const counts = Object.fromEntries(JOURNEY_KINDS.map((k) => [k, 0])) as Record<JourneyEventKind, number>;
  for (const e of filtered) counts[e.kind] += 1;

  let firstTs: string | undefined;
  let lastTs: string | undefined;
  for (const e of filtered) {
    if (firstTs === undefined || e.ts < firstTs) firstTs = e.ts;
    if (lastTs === undefined || e.ts > lastTs) lastTs = e.ts;
  }

  const limited = opts.limit && opts.limit > 0 ? filtered.slice(0, Math.floor(opts.limit)) : filtered;
  return { events: limited, counts, total: filtered.length, firstTs, lastTs, empty: filtered.length === 0 };
}

/** Resolve `--since`/`--until` (a duration like `30d`/`12h` or an ISO date) to ISO bounds (injected clock). */
export function resolveJourneyRange(spec: { since?: string; until?: string } = {}, now: Date = new Date()): { sinceIso?: string; untilIso?: string } {
  const out: { sinceIso?: string; untilIso?: string } = {};
  if (spec.since) out.sinceIso = parseCutoff(spec.since, now).toISOString();
  if (spec.until) out.untilIso = parseCutoff(spec.until, now).toISOString();
  return out;
}

// ───────────────────────────── thin DB query layer (read-only) ─────────────────────────────

/** A time range for the DB read layer. */
export interface MemGraphRange {
  sinceIso?: string;
  untilIso?: string;
  /** Cap rows read per table (most-recent first); 0/undefined = all. */
  limit?: number;
}

function rangeClause(col: string, range: MemGraphRange, params: (string | number)[]): string {
  const where: string[] = [];
  if (range.sinceIso) {
    where.push(`${col} >= ?`);
    params.push(range.sinceIso);
  }
  if (range.untilIso) {
    where.push(`${col} < ?`);
    params.push(range.untilIso);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}
const limitClause = (range: MemGraphRange): string => (range.limit && range.limit > 0 ? `LIMIT ${Math.floor(range.limit)}` : '');

/** Read the rows the memory graph is built from, read-only, from an existing DB. */
export function queryMemGraphInput(db: Db, range: MemGraphRange = {}): MemGraphInput {
  const factP: (string | number)[] = [];
  const facts = db
    .all<{ id: string; kind: string; scope: string | null; namespace: string | null; content: string; source: string | null; created_at: string }>(
      `SELECT id, kind, scope, namespace, content, source, created_at FROM facts ${rangeClause('created_at', range, factP)} ORDER BY created_at DESC ${limitClause(range)}`,
      ...factP,
    )
    .map((r) => ({ id: r.id, kind: r.kind, scope: r.scope ?? undefined, namespace: r.namespace ?? undefined, content: r.content, source: r.source ?? undefined, createdAt: r.created_at }));

  const skillP: (string | number)[] = [];
  const skills = db
    .all<{ id: string; name: string; status: string; source_runs: string; created_at: string }>(
      `SELECT id, name, status, source_runs, created_at FROM distilled_skills ${rangeClause('created_at', range, skillP)} ORDER BY created_at DESC ${limitClause(range)}`,
      ...skillP,
    )
    .map((r) => ({ id: r.id, name: r.name, status: r.status, sourceRuns: fromJson<string[]>(r.source_runs, []), createdAt: r.created_at }));

  const runP: (string | number)[] = [];
  const runs = db
    .all<{ id: string; session_id: string | null; parent_run_id: string | null; kind: string; status: string; started_at: string }>(
      `SELECT id, session_id, parent_run_id, kind, status, started_at FROM runs ${rangeClause('started_at', range, runP)} ORDER BY started_at DESC ${limitClause(range)}`,
      ...runP,
    )
    .map((r) => ({ id: r.id, sessionId: r.session_id ?? undefined, parentRunId: r.parent_run_id ?? undefined, kind: r.kind, status: r.status, startedAt: r.started_at }));

  const sesP: (string | number)[] = [];
  const sessions = db
    .all<{ id: string; title: string | null; created_at: string }>(
      `SELECT id, title, created_at FROM sessions ${rangeClause('created_at', range, sesP)} ORDER BY created_at DESC ${limitClause(range)}`,
      ...sesP,
    )
    .map((r) => ({ id: r.id, title: r.title ?? undefined, createdAt: r.created_at }));

  const knP: (string | number)[] = [];
  const knowledge = db
    .all<{ source_id: string; title: string | null; chunks: number; created_at: string }>(
      `SELECT source_id, MIN(title) AS title, COUNT(*) AS chunks, MIN(created_at) AS created_at FROM knowledge GROUP BY source_id ${rangeClause('MIN(created_at)', range, knP).replace('WHERE', 'HAVING')} ORDER BY created_at DESC ${limitClause(range)}`,
      ...knP,
    )
    .map((r) => ({ sourceId: r.source_id, title: r.title ?? undefined, chunks: Number(r.chunks) || 0, createdAt: r.created_at }));

  return { facts, skills, runs, sessions, knowledge };
}

/** Build the memory graph directly from an existing DB (read-only). */
export function buildMemGraphFromDb(db: Db, opts: { range?: MemGraphRange; top?: number } = {}): MemGraph {
  return buildMemGraph(queryMemGraphInput(db, opts.range ?? {}), { top: opts.top });
}

/** Read journey events (facts, skills, knowledge, runs, reflections, sessions) from an existing DB, read-only. */
export function queryJourneyEvents(db: Db, range: MemGraphRange = {}): JourneyEvent[] {
  const input = queryMemGraphInput(db, range);
  const reflP: (string | number)[] = [];
  const reflections = db
    .all<{ id: string; run_id: string | null; skill: string | null; verdict: string | null; score: number | null; created_at: string }>(
      `SELECT id, run_id, skill, verdict, score, created_at FROM reflections ${rangeClause('created_at', range, reflP)} ORDER BY created_at DESC ${limitClause(range)}`,
      ...reflP,
    )
    .map((r) => ({ id: r.id, runId: r.run_id ?? undefined, skill: r.skill ?? undefined, verdict: r.verdict ?? undefined, score: r.score ?? undefined, createdAt: r.created_at }));
  return journeyEventsFrom({ ...input, reflections });
}

/** Fetch + assemble the journey timeline in one call (read-only). */
export function buildJourney(db: Db, opts: { range?: MemGraphRange; options?: JourneyOptions } = {}): JourneyTimeline {
  const events = queryJourneyEvents(db, opts.range ?? {});
  return buildJourneyTimeline(events, opts.options ?? {});
}
