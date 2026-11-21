/**
 * Evaluation-driven self-improvement — data model + store port.
 *
 * An {@link EvalCase} is a labeled, reproducible test promoted from a real (or 👍-rated) run: the
 * original input plus the expected outcome (tools that should fire, text the output must contain, a
 * reference output for similarity, and an optional per-task cost budget). Cases are grouped into an
 * {@link EvalSuite} (scoped to an agent/model). Replaying a suite yields an {@link EvalScoreRecord}
 * — pass-rate, cost-per-task, intervention-rate and output-similarity combined into a single score
 * — persisted as a time series so the admin scorecard can chart a metric trend per agent over time.
 *
 * Persistence goes through the {@link EvalStore} port (one real SQLite implementation in
 * `store.ts`); the service depends only on this interface — mirroring the distill/timetravel
 * convention (no mocks in product code; the same real store is used in tests).
 */
import type { EvalObservation } from '../eval/suite.js';

/** The expected outcome labeled onto an eval case (every present condition must hold to pass). */
export interface EvalExpected {
  /** Tools that must have been invoked during the run. */
  tools?: string[];
  /** Substrings the output must contain (case-insensitive). */
  contains?: string[];
  /** Reference output used for the output-similarity metric (token-overlap). */
  output?: string;
  /** Per-task cost ceiling ($); a run costing more than this fails the case. */
  maxCost?: number;
}

/** A labeled, reproducible eval case promoted from a real run. */
export interface EvalCase {
  id: string;
  suiteId: string;
  /** Human-readable label. */
  name: string;
  /** The input replayed against the agent. */
  input: string;
  expected: EvalExpected;
  /** Provenance — the run id this case was promoted from, if any. */
  sourceRunId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** A named group of eval cases, scoped to an agent (model). */
export interface EvalSuite {
  id: string;
  name: string;
  /** The agent/model this suite scores (used to group the scorecard trend). */
  agent: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields needed to create a new eval case. */
export interface NewEvalCase {
  suiteId: string;
  name: string;
  input: string;
  expected?: EvalExpected;
  sourceRunId?: string;
  tags?: string[];
}

/** A single recorded suite score (one row of the scorecard time series). */
export interface EvalScoreRecord {
  id: string;
  suiteId: string;
  agent: string;
  /** Fraction of cases that passed, 0..1. */
  passRate: number;
  /** Mean cost per case ($). */
  costPerTask: number;
  /** Fraction of cases that errored / needed intervention, 0..1. */
  interventionRate: number;
  /** Mean output similarity against the reference outputs, 0..1. */
  similarity: number;
  /** Combined 0..1 score (weighted blend of the four metrics). */
  score: number;
  /** Number of cases scored. */
  cases: number;
  /** Optional label (e.g. "baseline", "after-tune:model-routing"). */
  label?: string;
  createdAt: string;
}

/** Persistence port for eval suites, cases and the score time series. */
export interface EvalStore {
  createSuite(name: string, agent: string, description?: string): EvalSuite;
  getSuite(id: string): EvalSuite | undefined;
  getSuiteByName(name: string): EvalSuite | undefined;
  listSuites(): EvalSuite[];
  removeSuite(id: string): boolean;

  addCase(c: NewEvalCase): EvalCase;
  getCase(id: string): EvalCase | undefined;
  listCases(suiteId: string): EvalCase[];
  removeCase(id: string): boolean;

  recordScore(score: Omit<EvalScoreRecord, 'id' | 'createdAt'>): EvalScoreRecord;
  listScores(suiteId: string, limit?: number): EvalScoreRecord[];
  /** Keep only the newest `keep` scores for a suite; prune the rest. Returns number removed. */
  pruneScores(suiteId: string, keep: number): number;
}

/** Per-run knobs a candidate tune can override without mutating config (used to test proposals). */
export interface RunOverrides {
  model?: string;
  pattern?: string;
  temperature?: number;
}

/** Runs one eval case against the real agent and returns what was observed. */
export type EvalCaseRunner = (c: EvalCase, overrides?: RunOverrides) => Promise<EvalObservation>;

/** Per-case outcome produced by the scorer. */
export interface EvalCaseResult {
  id: string;
  name: string;
  pass: boolean;
  cost: number;
  similarity: number;
  intervened: boolean;
  reasons: string[];
}

/** Aggregate metrics + combined score for a suite run. */
export interface EvalSuiteScore {
  suiteId: string;
  agent: string;
  cases: number;
  passRate: number;
  costPerTask: number;
  interventionRate: number;
  similarity: number;
  score: number;
  results: EvalCaseResult[];
}

/** A change the tuner proposes, tests, and (if it improves the score) keeps — reversibly. */
export interface TuneProposal {
  /** Category of change. */
  kind: 'model-routing' | 'pattern' | 'temperature' | 'skill-promote' | 'skill-retire' | 'prompt';
  /** Human-readable summary of the change. */
  summary: string;
  /** Dotted config keys → new values applied when this proposal is kept (for config-based changes). */
  patch: Record<string, unknown>;
  /** For skill-promote/retire proposals: the distilled-skill id to act on. */
  skillId?: string;
}

/** The outcome of evaluating one proposal against the suite. */
export interface TuneEvaluation {
  proposal: TuneProposal;
  baselineScore: number;
  candidateScore: number;
  improvement: number;
  /** True when the candidate improved the score by at least the configured threshold. */
  accepted: boolean;
  /** Set when the proposal was rejected because it broke governance or the per-task budget. */
  rejectedReason?: string;
}

/** Persistence port for the versioned, reversible tune history. */
export interface TuneStore {
  record(r: Omit<TuneRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'reverted'>): TuneRecord;
  get(id: string): TuneRecord | undefined;
  list(suiteId?: string, limit?: number): TuneRecord[];
  /** Mark a record reverted (idempotent); returns the updated record. */
  markReverted(id: string): TuneRecord | undefined;
}

/** A persisted, versioned, reversible accepted tune. */
export interface TuneRecord {
  id: string;
  suiteId: string;
  agent: string;
  kind: string;
  summary: string;
  patch: Record<string, unknown>;
  /** The previous values of the patched keys, so the change can be reverted. */
  previous: Record<string, unknown>;
  baselineScore: number;
  candidateScore: number;
  status: string;
  reverted: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
