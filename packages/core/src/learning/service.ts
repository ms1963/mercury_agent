/**
 * LearningService — the agent learns from its own run history.
 *
 * Three capabilities, all driven by the real `runs` table and the EventBus (no external state):
 *
 *   1a Experience retrieval — before a run, find the most similar PAST SUCCESSFUL run and
 *      distil a concise hint that is injected into the run-start context (via the agent's
 *      system prompt). Degrades to no hint when there is no useful prior run.
 *   1b Auto-tuned routing — record the ACTUAL outcome (success, cost, tokens) per
 *      (difficulty-bucket, model) from completed runs and feed observed success rates back so
 *      the router can prefer the model that actually works for a bucket. Falls back to the
 *      configured economics router when there is not enough data.
 *   1c Failure playbooks — on a recurring error signature across runs, store the remediation
 *      that a later (similar) run succeeded with; surface it on the next matching task/failure.
 *
 * The master switch (config.learning.enabled) is OFF by default, so nothing is recorded,
 * injected or adjusted unless explicitly enabled — fully backward-compatible.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import type { EventBus, MercuryEvent } from '../events/bus.js';
import type { RouteLearner, RouteSuggestion } from '../router/router.js';
import { inferDifficulty, routeBucket } from '../router/router.js';
import { newId, nowIso } from '../types/common.js';

/** Observed routing statistics for a (difficulty bucket, model) pair. */
export interface RouteStat {
  bucket: string;
  model: string;
  lane: string | null;
  runs: number;
  successes: number;
  successRate: number;
  costSum: number;
  tokensSum: number;
  avgCost: number;
}

/** A failure playbook: a recurring error signature and the remediation that later worked. */
export interface Playbook {
  id: string;
  signature: string;
  errorSample: string | null;
  taskSample: string | null;
  remediation: string | null;
  occurrences: number;
  successes: number;
  createdAt: string;
  updatedAt: string;
}

/** A hint distilled from a similar past successful run. */
export interface ExperienceHint {
  text: string;
  /** The past runs the hint was derived from (for transparency / tests). */
  sources: Array<{ runId: string; similarity: number }>;
}

interface RunRow {
  id: string;
  user_id: string | null;
  input: string | null;
  output: string | null;
  model: string | null;
  status: string;
  pattern: string | null;
  kind: string;
  started_at: string;
}

/** Difficulty bucket for a raw task string (offline, deterministic). */
export function bucketForTask(task: string): string {
  return routeBucket(inferDifficulty(task));
}

/** Lower-cased alphanumeric token set (>=3 chars), capped, for cheap similarity. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 200),
  );
}

/** Jaccard overlap of two token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Normalise an error message into a stable signature: strip run/uuids, numbers, quoted
 * paths and hex so the same class of failure maps to the same key across runs.
 */
export function errorSignature(text: string): string {
  return (
    (text || '')
      .toLowerCase()
      .replace(/error:\s*/g, '')
      .replace(/\b[0-9a-f]{6,}\b/g, '#')
      .replace(/run_[a-z0-9]+/g, '#')
      .replace(/['"`][^'"`]*['"`]/g, '…')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'unknown-error'
  );
}

export class LearningService implements RouteLearner {
  private off?: () => void;

  constructor(
    private config: MercuryConfig,
    private db: Db,
    private bus?: EventBus,
  ) {}

  /** Subscribe to run.end so outcomes are recorded automatically. Idempotent. */
  start(): void {
    if (this.off || !this.bus) return;
    this.off = this.bus.on('run.end', (e) => {
      try {
        this.recordOutcome(e);
      } catch {
        /* learning must never break a run */
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  get enabled(): boolean {
    return this.config.learning.enabled;
  }

  // ---- recording -------------------------------------------------------------------------

  /** Record the outcome of a finished run from its run.end event. */
  recordOutcome(e: MercuryEvent): void {
    if (!this.config.learning.enabled || !e.runId) return;
    const row = this.db.get<RunRow>('SELECT id, user_id, input, output, model, status, pattern, kind, started_at FROM runs WHERE id = ?', e.runId);
    if (!row) return;
    const data = (e.data ?? {}) as { status?: string; usage?: { inputTokens?: number; outputTokens?: number; cost?: number }; output?: string; error?: string };
    const status = data.status ?? row.status;
    const completed = status === 'completed';
    const input = row.input ?? '';
    const output = data.output ?? row.output ?? '';

    if (this.config.learning.routing.enabled && row.model) {
      const cost = data.usage?.cost ?? 0;
      const tokens = (data.usage?.inputTokens ?? 0) + (data.usage?.outputTokens ?? 0);
      this.upsertRouteStat(bucketForTask(input), row.model, cost, tokens, completed);
    }

    if (this.config.learning.playbooks.enabled && input) {
      if (!completed && (output || data.error)) this.recordFailure(input, output || data.error || '');
      else if (completed) this.recordRemediationFromSuccess(row.user_id, input, output, row.pattern, row.started_at);
    }
  }

  private upsertRouteStat(bucket: string, model: string, cost: number, tokens: number, success: boolean): void {
    const existing = this.db.get<{ runs: number }>('SELECT runs FROM learning_route_stats WHERE bucket = ? AND model = ?', bucket, model);
    if (existing) {
      this.db.run(
        'UPDATE learning_route_stats SET runs = runs + 1, successes = successes + ?, cost_sum = cost_sum + ?, tokens_sum = tokens_sum + ?, updated_at = ? WHERE bucket = ? AND model = ?',
        success ? 1 : 0,
        cost,
        tokens,
        nowIso(),
        bucket,
        model,
      );
    } else {
      this.db.run(
        'INSERT INTO learning_route_stats (bucket, model, lane, runs, successes, cost_sum, tokens_sum, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        bucket,
        model,
        null,
        1,
        success ? 1 : 0,
        cost,
        tokens,
        nowIso(),
      );
    }
  }

  /** Record (or bump) a failure signature as a candidate playbook. */
  recordFailure(task: string, errorText: string): Playbook {
    const sig = errorSignature(errorText);
    const now = nowIso();
    const existing = this.db.get<{ id: string }>('SELECT id FROM learning_playbooks WHERE signature = ?', sig);
    if (existing) {
      this.db.run('UPDATE learning_playbooks SET occurrences = occurrences + 1, error_sample = ?, task_sample = COALESCE(task_sample, ?), updated_at = ? WHERE signature = ?', errorText.slice(0, 500), task.slice(0, 500), now, sig);
    } else {
      this.db.run(
        'INSERT INTO learning_playbooks (id, signature, error_sample, task_sample, remediation, occurrences, successes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        newId('pb'),
        sig,
        errorText.slice(0, 500),
        task.slice(0, 500),
        null,
        1,
        0,
        now,
        now,
      );
    }
    return this.playbook(sig)!;
  }

  /**
   * When a run succeeds, look for a recently-failed playbook whose task is similar; if found and
   * it has no remediation yet, record what worked (pattern + output excerpt) as its remediation.
   */
  private recordRemediationFromSuccess(userId: string | null, task: string, output: string, pattern: string | null, _startedAt: string): void {
    const open = this.db.all<Playbook & { task_sample: string | null; error_sample: string | null }>(
      'SELECT * FROM learning_playbooks WHERE remediation IS NULL AND task_sample IS NOT NULL ORDER BY updated_at DESC LIMIT 50',
    );
    if (!open.length) return;
    const taskTok = tokens(task);
    const minSim = this.config.learning.playbooks.minSimilarity;
    let best: { row: (typeof open)[number]; sim: number } | undefined;
    for (const row of open) {
      const sim = jaccard(taskTok, tokens(row.task_sample ?? ''));
      if (sim >= minSim && (!best || sim > best.sim)) best = { row, sim };
    }
    if (!best) return;
    const remediation = `A similar task previously failed. A later attempt succeeded using the "${pattern ?? 'react'}" pattern. What worked: ${output.slice(0, 400).trim()}`;
    // The remediation quotes this user's output: record the owner so it is never surfaced to other users.
    this.db.run('UPDATE learning_playbooks SET remediation = ?, user_id = ?, successes = successes + 1, updated_at = ? WHERE id = ?', remediation, userId, nowIso(), best.row.id);
  }

  /** Explicitly set a remediation for a signature (CLI / API). */
  setRemediation(signature: string, remediation: string): Playbook | undefined {
    const sig = this.playbook(signature) ? signature : errorSignature(signature);
    const row = this.db.get<{ id: string }>('SELECT id FROM learning_playbooks WHERE signature = ?', sig);
    if (!row) return undefined;
    // Operator-curated remediation: shared with everyone.
    this.db.run('UPDATE learning_playbooks SET remediation = ?, user_id = NULL, updated_at = ? WHERE id = ?', remediation, nowIso(), row.id);
    return this.playbook(sig);
  }

  // ---- routing (1b) ----------------------------------------------------------------------

  /**
   * RouteLearner hook — among the candidate models, prefer the one with the best OBSERVED
   * success rate for this difficulty bucket, provided it has enough samples and clears the
   * configured minimum success rate. Returns null when there is insufficient data (the router
   * then keeps its economics/weighted choice — graceful fallback).
   */
  suggest(bucket: string, models: string[]): RouteSuggestion | null {
    if (!this.config.learning.enabled || !this.config.learning.routing.enabled || !models.length) return null;
    const { minSamples, minSuccessRate } = this.config.learning.routing;
    const stats = this.routeStats(bucket).filter((s) => models.includes(s.model) && s.runs >= minSamples && s.successRate >= minSuccessRate);
    if (!stats.length) return null;
    // Best observed success rate; ties broken by lower average cost.
    stats.sort((a, b) => b.successRate - a.successRate || a.avgCost - b.avgCost);
    const top = stats[0]!;
    return { model: top.model, reason: `learned: ${top.model} succeeded ${top.successes}/${top.runs} (${(top.successRate * 100).toFixed(0)}%) on ${bucket}-difficulty tasks` };
  }

  // ---- retrieval (1a) --------------------------------------------------------------------

  /**
   * Build a hint from the most similar PAST SUCCESSFUL run(s) plus any matching failure
   * playbook. Returns undefined when nothing clears the similarity bar (graceful empty case).
   */
  hintFor(task: string, userId?: string): ExperienceHint | undefined {
    if (!this.config.learning.enabled || !task.trim()) return undefined;
    const parts: string[] = [];
    const sources: Array<{ runId: string; similarity: number }> = [];

    if (this.config.learning.hints.enabled) {
      const { lookback, minSimilarity, maxExamples } = this.config.learning.hints;
      const rows = userId
        ? this.db.all<RunRow>("SELECT id, input, output, pattern FROM runs WHERE status = 'completed' AND user_id = ? AND input IS NOT NULL AND output IS NOT NULL ORDER BY started_at DESC LIMIT ?", userId, lookback)
        : this.db.all<RunRow>("SELECT id, input, output, pattern FROM runs WHERE status = 'completed' AND input IS NOT NULL AND output IS NOT NULL ORDER BY started_at DESC LIMIT ?", lookback);
      const taskTok = tokens(task);
      const scored = rows
        .map((r) => ({ r, sim: jaccard(taskTok, tokens(r.input ?? '')) }))
        .filter((x) => x.sim >= minSimilarity && (x.r.input ?? '').trim() !== task.trim())
        .sort((a, b) => b.sim - a.sim)
        .slice(0, maxExamples);
      for (const { r, sim } of scored) {
        parts.push(`Similar past task (handled successfully): "${(r.input ?? '').slice(0, 160).trim()}"\n  Approach that worked: ${(r.output ?? '').slice(0, 300).trim()}`);
        sources.push({ runId: r.id, similarity: Math.round(sim * 1000) / 1000 });
      }
    }

    const pb = this.playbookForTask(task, userId);
    if (pb?.remediation) parts.push(`Known pitfall for similar tasks: ${pb.remediation}`);

    if (!parts.length) return undefined;
    return { text: `## Learned from past runs\n${parts.join('\n\n')}`, sources };
  }

  // ---- playbook retrieval (1c) -----------------------------------------------------------

  /** Find a playbook (with a remediation, enough occurrences) relevant to a new task. */
  playbookForTask(task: string, userId?: string): Playbook | undefined {
    if (!this.config.learning.playbooks.enabled) return undefined;
    const { minOccurrences, minSimilarity } = this.config.learning.playbooks;
    // With a user: shared (operator-set) remediations plus the user's own auto-derived ones only.
    const rows = userId
      ? this.db.all<Record<string, unknown>>('SELECT * FROM learning_playbooks WHERE remediation IS NOT NULL AND occurrences >= ? AND (user_id IS NULL OR user_id = ?) ORDER BY updated_at DESC LIMIT 100', minOccurrences, userId)
      : this.db.all<Record<string, unknown>>('SELECT * FROM learning_playbooks WHERE remediation IS NOT NULL AND occurrences >= ? ORDER BY updated_at DESC LIMIT 100', minOccurrences);
    const taskTok = tokens(task);
    let best: { row: (typeof rows)[number]; sim: number } | undefined;
    for (const row of rows) {
      const sim = jaccard(taskTok, tokens((row.task_sample as string | null) ?? ''));
      if (sim >= minSimilarity && (!best || sim > best.sim)) best = { row, sim };
    }
    return best ? this.toPlaybook(best.row) : undefined;
  }

  /** Retrieve a playbook by its error signature (exact or normalised). */
  playbook(signature: string): Playbook | undefined {
    const row =
      this.db.get<Record<string, unknown>>('SELECT * FROM learning_playbooks WHERE signature = ?', signature) ??
      this.db.get<Record<string, unknown>>('SELECT * FROM learning_playbooks WHERE signature = ?', errorSignature(signature));
    return row ? this.toPlaybook(row) : undefined;
  }

  /** Retrieve the playbook matching an error message (for surfacing on a fresh failure). */
  playbookForError(errorText: string): Playbook | undefined {
    return this.playbook(errorSignature(errorText));
  }

  // ---- reads (CLI / API) -----------------------------------------------------------------

  routeStats(bucket?: string): RouteStat[] {
    const rows = bucket
      ? this.db.all<Record<string, unknown>>('SELECT * FROM learning_route_stats WHERE bucket = ? ORDER BY runs DESC', bucket)
      : this.db.all<Record<string, unknown>>('SELECT * FROM learning_route_stats ORDER BY bucket, runs DESC');
    return rows.map((r) => {
      const runs = Number(r.runs ?? 0);
      const successes = Number(r.successes ?? 0);
      const costSum = Number(r.cost_sum ?? 0);
      return {
        bucket: String(r.bucket),
        model: String(r.model),
        lane: (r.lane as string | null) ?? null,
        runs,
        successes,
        successRate: runs ? successes / runs : 0,
        costSum,
        tokensSum: Number(r.tokens_sum ?? 0),
        avgCost: runs ? costSum / runs : 0,
      };
    });
  }

  playbooks(limit = 100): Playbook[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM learning_playbooks ORDER BY occurrences DESC, updated_at DESC LIMIT ?', limit).map((r) => this.toPlaybook(r));
  }

  private toPlaybook(r: Record<string, unknown>): Playbook {
    return {
      id: String(r.id),
      signature: String(r.signature),
      errorSample: (r.error_sample as string | null) ?? null,
      taskSample: (r.task_sample as string | null) ?? null,
      remediation: (r.remediation as string | null) ?? null,
      occurrences: Number(r.occurrences ?? 0),
      successes: Number(r.successes ?? 0),
      createdAt: String(r.created_at ?? ''),
      updatedAt: String(r.updated_at ?? ''),
    };
  }
}
