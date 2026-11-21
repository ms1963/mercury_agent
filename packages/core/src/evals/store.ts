/**
 * Real, durable eval + tune stores backed by the shared SQLite {@link Db} (tables `eval_suites`,
 * `eval_cases`, `eval_scores`, migration #9; `tune_history`, migration #10). No mocks: the eval
 * service depends only on the {@link EvalStore}/{@link TuneStore} ports and these are the single
 * concrete implementations used everywhere, including tests — mirroring the persistence convention
 * of the distill/timetravel subsystems.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import type {
  EvalCase,
  EvalExpected,
  EvalScoreRecord,
  EvalStore,
  EvalSuite,
  NewEvalCase,
  TuneRecord,
  TuneStore,
} from './ports.js';

interface SuiteRow {
  id: string;
  name: string;
  agent: string;
  description: string;
  created_at: string;
  updated_at: string;
}
interface CaseRow {
  id: string;
  suite_id: string;
  name: string;
  input: string;
  expected: string;
  source_run_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}
interface ScoreRow {
  id: string;
  suite_id: string;
  agent: string;
  pass_rate: number;
  cost_per_task: number;
  intervention_rate: number;
  similarity: number;
  score: number;
  cases: number;
  label: string | null;
  created_at: string;
}
interface TuneRow {
  id: string;
  suite_id: string;
  agent: string;
  kind: string;
  summary: string;
  patch: string;
  previous: string;
  baseline_score: number;
  candidate_score: number;
  status: string;
  reverted: number;
  version: number;
  created_at: string;
  updated_at: string;
}

const toSuite = (r: SuiteRow): EvalSuite => ({
  id: r.id,
  name: r.name,
  agent: r.agent,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCase = (r: CaseRow): EvalCase => ({
  id: r.id,
  suiteId: r.suite_id,
  name: r.name,
  input: r.input,
  expected: fromJson<EvalExpected>(r.expected, {}),
  sourceRunId: r.source_run_id ?? undefined,
  tags: fromJson<string[]>(r.tags, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toScore = (r: ScoreRow): EvalScoreRecord => ({
  id: r.id,
  suiteId: r.suite_id,
  agent: r.agent,
  passRate: r.pass_rate,
  costPerTask: r.cost_per_task,
  interventionRate: r.intervention_rate,
  similarity: r.similarity,
  score: r.score,
  cases: Number(r.cases) || 0,
  label: r.label ?? undefined,
  createdAt: r.created_at,
});

const toTune = (r: TuneRow): TuneRecord => ({
  id: r.id,
  suiteId: r.suite_id,
  agent: r.agent,
  kind: r.kind,
  summary: r.summary,
  patch: fromJson<Record<string, unknown>>(r.patch, {}),
  previous: fromJson<Record<string, unknown>>(r.previous, {}),
  baselineScore: r.baseline_score,
  candidateScore: r.candidate_score,
  status: r.status,
  reverted: !!r.reverted,
  version: Number(r.version) || 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteEvalStore implements EvalStore {
  constructor(private db: Db) {}

  createSuite(name: string, agent: string, description = ''): EvalSuite {
    const existing = this.getSuiteByName(name);
    if (existing) return existing;
    const now = nowIso();
    const id = newId('suite');
    this.db.run(
      'INSERT INTO eval_suites (id, name, agent, description, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      id,
      name,
      agent || 'default',
      description,
      now,
      now,
    );
    return this.getSuite(id)!;
  }

  getSuite(id: string): EvalSuite | undefined {
    const r = this.db.get<SuiteRow>('SELECT * FROM eval_suites WHERE id = ?', id);
    return r ? toSuite(r) : undefined;
  }

  getSuiteByName(name: string): EvalSuite | undefined {
    const r = this.db.get<SuiteRow>('SELECT * FROM eval_suites WHERE name = ?', name);
    return r ? toSuite(r) : undefined;
  }

  listSuites(): EvalSuite[] {
    return this.db.all<SuiteRow>('SELECT * FROM eval_suites ORDER BY created_at DESC').map(toSuite);
  }

  removeSuite(id: string): boolean {
    this.db.run('DELETE FROM eval_cases WHERE suite_id = ?', id);
    this.db.run('DELETE FROM eval_scores WHERE suite_id = ?', id);
    return this.db.run('DELETE FROM eval_suites WHERE id = ?', id).changes > 0;
  }

  addCase(c: NewEvalCase): EvalCase {
    const now = nowIso();
    const id = newId('case');
    this.db.run(
      `INSERT INTO eval_cases (id, suite_id, name, input, expected, source_run_id, tags, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      c.suiteId,
      c.name,
      c.input,
      toJson(c.expected ?? {}),
      c.sourceRunId ?? null,
      toJson(c.tags ?? []),
      now,
      now,
    );
    this.db.run('UPDATE eval_suites SET updated_at = ? WHERE id = ?', now, c.suiteId);
    return this.getCase(id)!;
  }

  getCase(id: string): EvalCase | undefined {
    const r = this.db.get<CaseRow>('SELECT * FROM eval_cases WHERE id = ?', id);
    return r ? toCase(r) : undefined;
  }

  listCases(suiteId: string): EvalCase[] {
    return this.db
      .all<CaseRow>('SELECT * FROM eval_cases WHERE suite_id = ? ORDER BY created_at ASC', suiteId)
      .map(toCase);
  }

  removeCase(id: string): boolean {
    return this.db.run('DELETE FROM eval_cases WHERE id = ?', id).changes > 0;
  }

  recordScore(s: Omit<EvalScoreRecord, 'id' | 'createdAt'>): EvalScoreRecord {
    const id = newId('score');
    const now = nowIso();
    this.db.run(
      `INSERT INTO eval_scores (id, suite_id, agent, pass_rate, cost_per_task, intervention_rate, similarity, score, cases, label, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      s.suiteId,
      s.agent,
      s.passRate,
      s.costPerTask,
      s.interventionRate,
      s.similarity,
      s.score,
      s.cases,
      s.label ?? null,
      now,
    );
    return toScore(this.db.get<ScoreRow>('SELECT * FROM eval_scores WHERE id = ?', id)!);
  }

  listScores(suiteId: string, limit = 100): EvalScoreRecord[] {
    return this.db
      .all<ScoreRow>('SELECT * FROM eval_scores WHERE suite_id = ? ORDER BY created_at ASC LIMIT ?', suiteId, limit)
      .map(toScore);
  }

  pruneScores(suiteId: string, keep: number): number {
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM eval_scores WHERE suite_id = ?', suiteId)?.n ?? 0;
    const excess = total - keep;
    if (excess <= 0) return 0;
    const victims = this.db.all<{ id: string }>(
      'SELECT id FROM eval_scores WHERE suite_id = ? ORDER BY created_at ASC LIMIT ?',
      suiteId,
      excess,
    );
    let removed = 0;
    for (const v of victims) removed += this.db.run('DELETE FROM eval_scores WHERE id = ?', v.id).changes > 0 ? 1 : 0;
    return removed;
  }
}

export class SqliteTuneStore implements TuneStore {
  constructor(private db: Db) {}

  record(r: Omit<TuneRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'reverted'>): TuneRecord {
    const id = newId('tune');
    const now = nowIso();
    // Version is monotonic per suite so applied changes are ordered/traceable.
    const prevMax =
      this.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM tune_history WHERE suite_id = ?', r.suiteId)?.v ?? 0;
    this.db.run(
      `INSERT INTO tune_history (id, suite_id, agent, kind, summary, patch, previous, baseline_score, candidate_score, status, reverted, version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      id,
      r.suiteId,
      r.agent,
      r.kind,
      r.summary,
      toJson(r.patch),
      toJson(r.previous),
      r.baselineScore,
      r.candidateScore,
      r.status,
      prevMax + 1,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): TuneRecord | undefined {
    const r = this.db.get<TuneRow>('SELECT * FROM tune_history WHERE id = ?', id);
    return r ? toTune(r) : undefined;
  }

  list(suiteId?: string, limit = 100): TuneRecord[] {
    const rows = suiteId
      ? this.db.all<TuneRow>('SELECT * FROM tune_history WHERE suite_id = ? ORDER BY created_at DESC LIMIT ?', suiteId, limit)
      : this.db.all<TuneRow>('SELECT * FROM tune_history ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map(toTune);
  }

  markReverted(id: string): TuneRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.db.run("UPDATE tune_history SET reverted = 1, status = 'reverted', updated_at = ? WHERE id = ?", nowIso(), id);
    return this.get(id);
  }
}
