/**
 * Ports for deterministic run replay & time-travel debugging.
 *
 * A {@link RunTraceRecord} is the durable, per-run metadata that makes a replay reproducible: the
 * original input, the deterministic seed/options (model, pattern, provider seed...), and — for a
 * forked run — the lineage (parent run id + the step it forked from + the edits applied). The
 * ordered, human-readable step list itself is reconstructed on demand from the recorded event
 * stream (see {@link buildTrace}); only the metadata and (optionally) reconstructed state deltas
 * are stored here. The {@link TraceStore} is the single persistence port, mirroring the
 * distill/learning/reliability convention (one real SQLite implementation used everywhere).
 */
import type { ChatMessage } from '../types/messages.js';

/** Deterministic knobs captured at run start so a replay reproduces the same downstream path. */
export interface TraceSeed {
  model?: string;
  pattern?: string;
  platform?: string;
  /** Provider/temperature seed when the provider supports deterministic sampling. */
  seed?: number;
  [k: string]: unknown;
}

/** An edit applied when forking a run: replace the input, or override a tool call's arguments. */
export interface ReplayEdit {
  /** Replace the run input for the recomputed portion. */
  input?: string;
  /** Override arguments of the tool call at a given step (0-based step index). */
  toolArgs?: Record<string, unknown>;
}

/** Durable per-run trace metadata + fork lineage (table `run_traces`, migration #8). */
export interface RunTraceRecord {
  runId: string;
  sessionId?: string;
  userId?: string;
  input?: string;
  seed: TraceSeed;
  /** Number of recorded steps (updated on run.end). */
  steps: number;
  /** For a forked run: the parent run it was derived from. */
  parentRunId?: string;
  /** For a forked run: the step index it forked from. */
  fromStep?: number;
  /** For a forked run: the edits applied at the fork. */
  edits?: ReplayEdit;
  /** Optional reconstructed per-step state deltas (only when config.replay.persistDeltas). */
  deltas?: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when first recording a run's trace metadata. */
export interface NewRunTrace {
  runId: string;
  sessionId?: string;
  userId?: string;
  input?: string;
  seed?: TraceSeed;
  parentRunId?: string;
  fromStep?: number;
  edits?: ReplayEdit;
}

/** Persistence port for run-trace metadata (one concrete SQLite implementation). */
export interface TraceStore {
  /** Create (or replace) the trace row for a run. */
  upsert(trace: NewRunTrace): RunTraceRecord;
  /** Update mutable fields (step count, deltas) once a run finishes. */
  update(runId: string, patch: Partial<Pick<RunTraceRecord, 'steps' | 'deltas'>>): RunTraceRecord | undefined;
  get(runId: string): RunTraceRecord | undefined;
  list(userId?: string, limit?: number): RunTraceRecord[];
  /** Direct children (forks) of a run. */
  children(runId: string): RunTraceRecord[];
  remove(runId: string): boolean;
  /** Keep only the newest `keep` traces; prune the rest. Returns number removed. */
  prune(keep: number): number;
}

/** Reconstructed, accumulated state of a run as of a given step (time-travel inspection). */
export interface ReplayState {
  runId: string;
  /** 1-based number of steps included (0 = before the run started). */
  step: number;
  totalSteps: number;
  input?: string;
  cost: number;
  tokens: number;
  llmCalls: number;
  toolCalls: number;
  decisions: number;
  tainted: boolean;
  lastThought?: string;
  lastOutput?: string;
  /** Tool results observed up to this step. */
  toolResults: Array<{ name: string; ok: boolean; preview: string }>;
  /** Reconstructed conversation (user/assistant/tool messages) up to this step. */
  messages: ChatMessage[];
}

/** Request handed to the runtime fork runner: re-run with the reused upstream prefix + edited input. */
export interface ReplayForkRequest {
  parentRunId: string;
  fromStep: number;
  edits?: ReplayEdit;
  seed: TraceSeed;
  /** The (possibly edited) input that drives the recomputed downstream portion. */
  input: string;
  /** Reconstructed upstream prefix (reused as context, not recomputed). */
  prefixMessages: ChatMessage[];
  userId?: string;
}

/** Outcome of a forked run. */
export interface ReplayRunResult {
  runId: string;
  status: string;
  output: string;
  toolNames: string[];
}

/**
 * Executes a fork: seeds a fresh run with the reused prefix + edited input and runs the real agent.
 * Injected by the runtime (keeps the core service decoupled from the agent/memory wiring).
 */
export type ReplayForkRunner = (req: ReplayForkRequest) => Promise<ReplayRunResult>;

/** Result of a replay/fork: the new linked run plus its lineage. */
export interface ReplayResult {
  parentRunId: string;
  fromStep: number;
  edits?: ReplayEdit;
  run: ReplayRunResult;
}
