/**
 * DecisionEngine: provider chain with fallback, decision logging, events and calibration.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import { errorMessage, newId, nowIso } from '../types/common.js';
import type { ChoiceAnswer, DecisionProvider, DecisionRequest, DecisionResult, NoulAnswer, Question, ScoreAnswer } from './types.js';

export interface CalibrationBin {
  bin: string;
  n: number;
  meanPredicted: number;
  meanObserved: number;
}

export interface CalibrationReport {
  purpose: string;
  n: number;
  brier: number | null;
  bins: CalibrationBin[];
}

export class DecisionEngine {
  constructor(
    private providers: DecisionProvider[],
    private bus?: EventBus,
    private db?: Db,
  ) {}

  /** Names of providers in fallback order (only available ones). */
  chain(): string[] {
    return this.providers.filter((p) => p.available()).map((p) => p.name);
  }

  setProviders(providers: DecisionProvider[]): void {
    this.providers = providers;
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if (!p.available()) continue;
      try {
        const result = await p.decide(req);
        result.id = this.log(req, result);
        return result;
      } catch (err) {
        errors.push(`${p.name}: ${errorMessage(err)}`);
      }
    }
    throw new Error(`All decision providers failed: ${errors.join('; ')}`);
  }

  async choice(state: unknown, instructions: string, criteria: Record<string, string>, purpose = 'adhoc', runId?: string): Promise<ChoiceAnswer & { id?: string; provider: string }> {
    const r = await this.decide({ state, questions: { q: { type: 'choice', instructions, criteria } }, purpose, runId });
    return { ...(r.answers.q as ChoiceAnswer), id: r.id, provider: r.provider };
  }

  async noul(state: unknown, instructions: string, purpose = 'adhoc', runId?: string, criteria?: { true?: string; false?: string }): Promise<NoulAnswer & { id?: string; provider: string }> {
    const q: Question = { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
    const r = await this.decide({ state, questions: { q }, purpose, runId });
    return { ...(r.answers.q as NoulAnswer), id: r.id, provider: r.provider };
  }

  async score(state: unknown, instructions: string, levels: string[], purpose = 'adhoc', runId?: string): Promise<ScoreAnswer & { id?: string; provider: string; fraction: number }> {
    const r = await this.decide({ state, questions: { q: { type: 'score', instructions, criteria: levels } }, purpose, runId });
    const a = r.answers.q as ScoreAnswer;
    return { ...a, id: r.id, provider: r.provider, fraction: levels.length > 1 ? Math.max(0, Math.min(1, a.score / (levels.length - 1))) : 0 };
  }

  /** Record the observed outcome (0..1) of a previous decision for calibration. */
  recordOutcome(decisionId: string, outcome: number): void {
    this.db?.run('UPDATE decisions SET outcome = ? WHERE id = ?', Math.max(0, Math.min(1, outcome)), decisionId);
  }

  recent(limit = 50, purpose?: string): Array<Record<string, unknown>> {
    if (!this.db) return [];
    const rows = purpose
      ? this.db.all<Record<string, unknown>>('SELECT * FROM decisions WHERE purpose = ? ORDER BY created_at DESC LIMIT ?', purpose, limit)
      : this.db.all<Record<string, unknown>>('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, question: fromJson(r.question, {}), answer: fromJson(r.answer, {}) }));
  }

  /** Reliability diagram + Brier score over decisions that have an observed outcome. */
  calibration(purpose?: string): CalibrationReport {
    const rows = (this.db?.all<{ confidence: number; outcome: number }>(
      `SELECT confidence, outcome FROM decisions WHERE outcome IS NOT NULL AND confidence IS NOT NULL ${purpose ? 'AND purpose = ?' : ''}`,
      ...(purpose ? [purpose] : []),
    ) ?? []);
    const bins = [0, 0.2, 0.4, 0.6, 0.8].map((lo) => {
      const inBin = rows.filter((r) => r.confidence >= lo && (r.confidence < lo + 0.2 || (lo === 0.8 && r.confidence <= 1)));
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      return { bin: `${lo.toFixed(1)}-${(lo + 0.2).toFixed(1)}`, n: inBin.length, meanPredicted: mean(inBin.map((r) => r.confidence)), meanObserved: mean(inBin.map((r) => r.outcome)) };
    });
    const brier = rows.length ? rows.reduce((s, r) => s + (r.confidence - r.outcome) ** 2, 0) / rows.length : null;
    return { purpose: purpose ?? 'all', n: rows.length, brier, bins };
  }

  private log(req: DecisionRequest, result: DecisionResult): string {
    const id = newId('dec');
    const first = Object.values(result.answers)[0];
    const confidence = first ? (first.type === 'noul' ? first.noul : (first.confidence ?? null)) : null;
    this.db?.run(
      'INSERT INTO decisions (id, run_id, purpose, provider, model, question, answer, confidence, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, req.runId, req.purpose ?? 'adhoc', result.provider, result.model, toJson({ state: truncateState(req.state), questions: req.questions }), toJson(result.answers), confidence, result.latencyMs, nowIso(),
    );
    this.bus?.emit({ type: 'decision', runId: req.runId, data: { id, purpose: req.purpose ?? 'adhoc', provider: result.provider, model: result.model, answers: result.answers, latencyMs: result.latencyMs } });
    return id;
  }
}

function truncateState(state: unknown): unknown {
  const s = typeof state === 'string' ? state : JSON.stringify(state);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : state;
}
