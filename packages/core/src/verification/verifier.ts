/**
 * Verifier: runs a task's checks, aggregates them into a confidence score and decides whether
 * the task is actually done (evidence-based), escalating for human review when confidence is
 * below the configured threshold.
 *
 * A task is "done" only when the required checks pass AND the aggregate confidence reaches the
 * threshold — never because the model merely claimed completion. Results and escalations are
 * persisted so the server and Web UI can show them.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../types/common.js';
import { defaultAssertionRegistry, runCheck, type AssertionChecker, type Check, type CheckResult, type CriticFn } from './checks.js';

export interface VerifyInput {
  taskId?: string;
  runId?: string;
  userId?: string;
  /** What the step was supposed to achieve (used by critic checks and the summary). */
  goal?: string;
  /** The step's produced text output (used by critic checks). */
  output?: string;
  /** The step's structured result (used by schema checks and assertions). */
  result?: unknown;
  checks: Check[];
  /** Override the configured confidence threshold for this verification. */
  threshold?: number;
}

export interface VerificationResult {
  id: string;
  taskId?: string;
  runId?: string;
  goal?: string;
  /** True when the task is evidence-backed done: required checks pass and confidence ≥ threshold. */
  passed: boolean;
  /** 0..1 weighted aggregate of the individual check scores. */
  confidence: number;
  threshold: number;
  /** True when the result was flagged for human review (confidence below threshold / required failed). */
  escalated: boolean;
  checks: CheckResult[];
  summary: string;
  createdAt: string;
}

export interface Escalation {
  id: string;
  verificationId?: string;
  taskId?: string;
  runId?: string;
  userId?: string;
  reason: string;
  confidence?: number;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
}

export class Verifier {
  readonly assertions: Map<string, AssertionChecker>;
  private critic?: CriticFn;

  constructor(private config: MercuryConfig, private db?: Db, private bus?: EventBus, critic?: CriticFn) {
    this.assertions = defaultAssertionRegistry();
    this.critic = critic;
  }

  /** Inject the critic backing (a second-model judge). Runtime wires this to the decision engine. */
  setCritic(fn: CriticFn): void {
    this.critic = fn;
  }

  /** Register an additional real-world assertion checker. */
  registerAssertion(name: string, checker: AssertionChecker): void {
    this.assertions.set(name, checker);
  }

  get enabled(): boolean {
    return this.config.verification.enabled;
  }

  /** Aggregate confidence: weighted mean of check scores (empty → 1, nothing to disprove). */
  private aggregate(results: CheckResult[]): number {
    if (!results.length) return 1;
    const totalWeight = results.reduce((s, r) => s + r.weight, 0) || 1;
    const sum = results.reduce((s, r) => s + r.score * r.weight, 0);
    return Math.round((sum / totalWeight) * 1e6) / 1e6;
  }

  /** Run every check and produce an aggregated, persisted verification result. */
  async verify(input: VerifyInput): Promise<VerificationResult> {
    const threshold = input.threshold ?? this.config.verification.confidenceThreshold;
    const enabledTypes = this.config.verification.checks;
    const checks = input.checks.filter((c) => enabledTypes.includes(c.type));
    const results: CheckResult[] = [];
    for (const check of checks) results.push(await runCheck(check, { output: input.output, result: input.result }, { critic: this.critic, assertions: this.assertions }));

    const requiredOk = results.filter((r) => r.required).every((r) => r.passed);
    const confidence = this.aggregate(results);
    const passed = requiredOk && confidence >= threshold;
    const escalate = this.config.verification.escalate && !passed;
    const failedReq = results.filter((r) => r.required && !r.passed).map((r) => r.type);
    const summary = `${results.filter((r) => r.passed).length}/${results.length} checks passed · confidence ${confidence.toFixed(2)} (threshold ${threshold})${passed ? ' · DONE' : failedReq.length ? ` · required failed: ${failedReq.join(', ')}` : ' · below threshold'}`;

    const result: VerificationResult = {
      id: newId('ver'),
      taskId: input.taskId,
      runId: input.runId,
      goal: input.goal,
      passed,
      confidence,
      threshold,
      escalated: escalate,
      checks: results,
      summary,
      createdAt: nowIso(),
    };

    this.persist(result, input.userId);
    this.bus?.emit({ type: 'verification.result', runId: input.runId, userId: input.userId, data: { id: result.id, taskId: result.taskId, passed, confidence, escalated: escalate, checks: results.length } });
    if (escalate) this.escalate(result, input.userId, `Verification confidence ${confidence.toFixed(2)} < threshold ${threshold}${failedReq.length ? `; required checks failed: ${failedReq.join(', ')}` : ''}`);
    return result;
  }

  private persist(r: VerificationResult, userId?: string): void {
    this.db?.run(
      'INSERT INTO verifications (id, task_id, run_id, user_id, goal, passed, confidence, threshold, escalated, checks, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      r.id, r.taskId ?? null, r.runId ?? null, userId ?? null, r.goal ?? null, r.passed ? 1 : 0, r.confidence, r.threshold, r.escalated ? 1 : 0, toJson(r.checks), r.summary, r.createdAt,
    );
  }

  /** Record an escalation (human-review flag) and emit an event. */
  escalate(r: VerificationResult, userId: string | undefined, reason: string): Escalation {
    const esc: Escalation = { id: newId('esc'), verificationId: r.id, taskId: r.taskId, runId: r.runId, userId, reason, confidence: r.confidence, status: 'open', createdAt: nowIso() };
    this.db?.run(
      'INSERT INTO escalations (id, verification_id, task_id, run_id, user_id, reason, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      esc.id, esc.verificationId ?? null, esc.taskId ?? null, esc.runId ?? null, esc.userId ?? null, esc.reason, esc.confidence ?? null, esc.status, esc.createdAt,
    );
    this.bus?.emit({ type: 'verification.escalated', runId: r.runId, userId, data: { id: esc.id, taskId: esc.taskId, confidence: r.confidence, reason } });
    return esc;
  }

  /** Recent verification results (most recent first). */
  list(taskId?: string, limit = 50): VerificationResult[] {
    if (!this.db) return [];
    const rows = taskId
      ? this.db.all('SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at DESC LIMIT ?', taskId, limit)
      : this.db.all('SELECT * FROM verifications ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => this.rowToResult(r));
  }

  get(id: string): VerificationResult | undefined {
    const row = this.db?.get('SELECT * FROM verifications WHERE id = ?', id);
    return row ? this.rowToResult(row) : undefined;
  }

  /** Open (or all) escalations, most recent first. */
  escalations(status: 'open' | 'resolved' | 'all' = 'open', limit = 50): Escalation[] {
    if (!this.db) return [];
    const rows = status === 'all'
      ? this.db.all('SELECT * FROM escalations ORDER BY created_at DESC LIMIT ?', limit)
      : this.db.all('SELECT * FROM escalations WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit);
    return rows.map((r) => this.rowToEscalation(r));
  }

  /** Mark an escalation resolved. Returns true when a row was updated. */
  resolveEscalation(id: string): boolean {
    return (this.db?.run('UPDATE escalations SET status = ?, resolved_at = ? WHERE id = ? AND status = ?', 'resolved', nowIso(), id, 'open').changes ?? 0) > 0;
  }

  private rowToResult(r: Record<string, unknown>): VerificationResult {
    return {
      id: String(r.id),
      taskId: (r.task_id as string) ?? undefined,
      runId: (r.run_id as string) ?? undefined,
      goal: (r.goal as string) ?? undefined,
      passed: Boolean(r.passed),
      confidence: Number(r.confidence),
      threshold: Number(r.threshold),
      escalated: Boolean(r.escalated),
      checks: fromJson<CheckResult[]>(r.checks, []),
      summary: String(r.summary ?? ''),
      createdAt: String(r.created_at),
    };
  }

  private rowToEscalation(r: Record<string, unknown>): Escalation {
    return {
      id: String(r.id),
      verificationId: (r.verification_id as string) ?? undefined,
      taskId: (r.task_id as string) ?? undefined,
      runId: (r.run_id as string) ?? undefined,
      userId: (r.user_id as string) ?? undefined,
      reason: String(r.reason ?? ''),
      confidence: r.confidence == null ? undefined : Number(r.confidence),
      status: (r.status as Escalation['status']) ?? 'open',
      createdAt: String(r.created_at),
      resolvedAt: (r.resolved_at as string) ?? undefined,
    };
  }
}
