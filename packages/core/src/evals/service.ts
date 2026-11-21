/**
 * Evaluation-driven self-improvement service.
 *
 * Ties the pieces together: promote a real run into a labeled {@link EvalCase}, replay a suite and
 * score it ({@link runSuite}) into a persisted {@link EvalScoreRecord} time series, chart the trend,
 * and run the governed auto-tuner ({@link proposeTune}/{@link applyTune}/{@link revertTune}). The
 * service depends only on the store ports, a live config reference, and an injected
 * {@link EvalCaseRunner} that runs a case against the real agent — no mocks in product code.
 *
 * Auto-tune safety: the harness is usable whenever `evals.enabled`, but applying a tune mutates
 * configuration, so {@link proposeTune} only auto-applies accepted proposals when BOTH
 * `evals.autotune.enabled` and `evals.autotune.autoApply` are set. Every applied change captures the
 * previous values and is recorded as a versioned, reversible {@link TuneRecord}.
 */
import type { Db } from '../db/db.js';
import { fromJson } from '../db/db.js';
import type { MercuryConfig } from '../config/schema.js';
import { getPath, setPath } from '../config/load.js';
import type { EventBus } from '../events/bus.js';
import type { DistilledSkill } from '../distill/ports.js';
import type {
  EvalCase,
  EvalCaseRunner,
  EvalScoreRecord,
  EvalStore,
  EvalSuite,
  EvalSuiteScore,
  NewEvalCase,
  RunOverrides,
  TuneEvaluation,
  TuneProposal,
  TuneRecord,
  TuneStore,
} from './ports.js';
import { aggregateScore, scoreCase, type ScoreWeights } from './scorer.js';
import { defaultProposals, evaluateProposal, overridesFor } from './tuner.js';

/** Minimal distiller surface the tuner needs (promote/retire a distilled skill reversibly). */
export interface SkillGovernor {
  list(status?: string): DistilledSkill[];
  get(id: string): DistilledSkill | undefined;
  approve(id: string): DistilledSkill | undefined;
  retire(id: string, reason?: string): DistilledSkill | undefined;
}

export interface EvalServiceOptions {
  /** Persists an accepted config patch so it survives restart (runtime wires this to the YAML writer). */
  persist?: (path: string, value: unknown) => void;
  /** Distilled-skills governor, enabling skill-promote/retire tune proposals. */
  distiller?: SkillGovernor;
  bus?: EventBus;
}

/** Fields accepted when promoting a run into an eval case (expected outcome may be auto-derived). */
export interface PromoteOptions {
  suiteId?: string;
  suiteName?: string;
  agent?: string;
  name?: string;
  /** Override the auto-derived expected outcome. */
  expected?: EvalCase['expected'];
  /** Derive `expected.tools` from the run's observed tool calls (default true). */
  deriveTools?: boolean;
  /** Derive `expected.output` (reference for similarity) from the run output (default true). */
  deriveOutput?: boolean;
  tags?: string[];
}

export class EvalService {
  constructor(
    private store: EvalStore,
    private tunes: TuneStore,
    private config: MercuryConfig,
    private runner: EvalCaseRunner,
    private db: Db,
    private opts: EvalServiceOptions = {},
  ) {}

  private get cfg() {
    return this.config.evals;
  }

  private get weights(): ScoreWeights {
    return { ...this.cfg.weights };
  }

  // ---- suites & cases ---------------------------------------------------------------------------

  createSuite(name: string, agent = 'default', description = ''): EvalSuite {
    return this.store.createSuite(name, agent, description);
  }

  listSuites(): EvalSuite[] {
    return this.store.listSuites();
  }

  getSuite(id: string): EvalSuite | undefined {
    return this.store.getSuite(id);
  }

  listCases(suiteId: string): EvalCase[] {
    return this.store.listCases(suiteId);
  }

  addCase(c: NewEvalCase): EvalCase {
    if (!this.store.getSuite(c.suiteId)) throw new Error(`unknown suite: ${c.suiteId}`);
    return this.store.addCase(c);
  }

  removeCase(id: string): boolean {
    return this.store.removeCase(id);
  }

  /**
   * Promote a real (or 👍-rated) run into a labeled eval case: read the run's input, observed tool
   * calls and output from the durable run log, and store them as the expected outcome so future
   * replays regress against proven behavior.
   */
  promoteRun(runId: string, opts: PromoteOptions = {}): EvalCase {
    const run = this.db.get<{ input: string | null; output: string | null; model: string | null }>(
      'SELECT input, output, model FROM runs WHERE id = ?',
      runId,
    );
    if (!run) throw new Error(`unknown run: ${runId}`);
    const input = (run.input ?? '').trim();
    if (!input) throw new Error(`run ${runId} has no input to promote`);

    const suite = this.resolveSuite(opts, run.model ?? 'default');
    const deriveTools = opts.deriveTools !== false;
    const deriveOutput = opts.deriveOutput !== false;

    const toolNames = deriveTools
      ? this.db
          .all<{ data: unknown }>("SELECT data FROM events WHERE run_id = ? AND type = 'tool.call' ORDER BY ts, rowid", runId)
          .map((r) => String(fromJson<{ name?: string }>(r.data, {}).name ?? ''))
          .filter(Boolean)
      : [];
    const uniqueTools = [...new Set(toolNames)];

    const expected: EvalCase['expected'] = opts.expected ?? {
      ...(uniqueTools.length ? { tools: uniqueTools } : {}),
      ...(deriveOutput && run.output ? { output: run.output } : {}),
    };

    const c = this.store.addCase({
      suiteId: suite.id,
      name: opts.name ?? `run ${runId.slice(0, 12)}`,
      input,
      expected,
      sourceRunId: runId,
      tags: opts.tags ?? ['promoted'],
    });
    this.opts.bus?.emit({ type: 'eval.case.promoted', runId, data: { caseId: c.id, suiteId: suite.id } });
    return c;
  }

  private resolveSuite(opts: PromoteOptions, agentFallback: string): EvalSuite {
    if (opts.suiteId) {
      const s = this.store.getSuite(opts.suiteId);
      if (!s) throw new Error(`unknown suite: ${opts.suiteId}`);
      return s;
    }
    const name = opts.suiteName ?? 'default';
    return this.store.getSuiteByName(name) ?? this.store.createSuite(name, opts.agent ?? agentFallback);
  }

  // ---- scoring ----------------------------------------------------------------------------------

  /**
   * Replay every case in a suite against the real agent, score the results, and (unless `dryRun`)
   * persist the aggregate as one point in the suite's score time series. Deterministic given a
   * deterministic runner.
   */
  async runSuite(
    suiteId: string,
    opts: { overrides?: RunOverrides; label?: string; dryRun?: boolean } = {},
  ): Promise<EvalSuiteScore> {
    const suite = this.store.getSuite(suiteId);
    if (!suite) throw new Error(`unknown suite: ${suiteId}`);
    const cases = this.store.listCases(suiteId);

    const results = [];
    for (const c of cases) {
      const obs = await this.runner(c, opts.overrides);
      results.push(scoreCase(c, obs));
    }

    const agg = aggregateScore(suiteId, suite.agent, results, this.weights, this.cfg.costCeiling);

    if (!opts.dryRun) {
      this.store.recordScore({
        suiteId,
        agent: suite.agent,
        passRate: agg.passRate,
        costPerTask: agg.costPerTask,
        interventionRate: agg.interventionRate,
        similarity: agg.similarity,
        score: agg.score,
        cases: agg.cases,
        label: opts.label,
      });
      this.store.pruneScores(suiteId, this.cfg.retainScores);
      this.opts.bus?.emit({ type: 'eval.suite.scored', data: { suiteId, score: agg.score, label: opts.label } });
    }
    return agg;
  }

  /** The persisted score time series for a suite (oldest → newest) — the scorecard trend. */
  trend(suiteId: string, limit?: number): EvalScoreRecord[] {
    return this.store.listScores(suiteId, limit);
  }

  // ---- governed auto-tune -----------------------------------------------------------------------

  /**
   * Measure one proposal with a real suite replay, applying its effect and reverting afterwards so
   * nothing leaks between candidates: config-knob proposals run via per-run overrides (config is
   * never mutated to test); skill-promote/retire proposals toggle the distilled skill, replay, then
   * restore the prior status.
   */
  private async measureProposal(p: TuneProposal): Promise<EvalSuiteScore> {
    if (p.kind === 'skill-promote' || p.kind === 'skill-retire') {
      const gov = this.opts.distiller;
      if (!gov || !p.skillId) return this.runSuite(p.patch['__suiteId'] as string, { dryRun: true });
      const suiteId = String(p.patch['__suiteId'] ?? '');
      const before = gov.get(p.skillId);
      const prevStatus = before?.status;
      try {
        if (p.kind === 'skill-promote') gov.approve(p.skillId);
        else gov.retire(p.skillId, 'tune-trial');
        return await this.runSuite(suiteId, { dryRun: true });
      } finally {
        // Restore prior status so measuring a proposal has no lasting effect.
        if (prevStatus === 'approved') gov.approve(p.skillId);
        else if (prevStatus === 'retired') gov.retire(p.skillId, 'tune-revert');
      }
    }
    const suiteId = String(p.patch['__suiteId'] ?? '');
    return this.runSuite(suiteId, { overrides: overridesFor(p), dryRun: true });
  }

  /**
   * Propose and score tune candidates against a suite. Returns the baseline score and one scored
   * {@link TuneEvaluation} per proposal (governance- and budget-checked). When
   * `evals.autotune.enabled` and `evals.autotune.autoApply` are both set, accepted proposals are
   * applied immediately; otherwise this is a dry run and applying is an explicit, governed step.
   */
  async proposeTune(
    suiteId: string,
    proposals?: TuneProposal[],
  ): Promise<{ baseline: EvalSuiteScore; evaluations: TuneEvaluation[]; applied: TuneRecord[] }> {
    const suite = this.store.getSuite(suiteId);
    if (!suite) throw new Error(`unknown suite: ${suiteId}`);

    const baseline = await this.runSuite(suiteId, { label: 'baseline', dryRun: true });

    const skills = this.opts.distiller?.list() ?? [];
    const candidates = (proposals ?? defaultProposals(this.config, skills)).slice(0, this.cfg.autotune.maxProposals);
    // Thread the suite id through to measureProposal via the patch (stripped before persistence).
    const tagged = candidates.map((p) => ({ ...p, patch: { ...p.patch, __suiteId: suiteId } }));

    const evaluations: TuneEvaluation[] = [];
    for (const p of tagged) {
      const evaln = await evaluateProposal(p, baseline, (pp) => this.measureProposal(pp), {
        minImprovement: this.cfg.autotune.minImprovement,
        costCeiling: this.cfg.costCeiling,
      });
      // Strip the internal suite-id marker from what we expose/persist.
      evaln.proposal = { ...evaln.proposal, patch: stripInternal(evaln.proposal.patch) };
      evaluations.push(evaln);
    }

    const applied: TuneRecord[] = [];
    if (this.cfg.autotune.enabled && this.cfg.autotune.autoApply) {
      for (const e of evaluations) if (e.accepted) applied.push(this.applyTune(suiteId, e));
    }
    this.opts.bus?.emit({
      type: 'eval.tune.proposed',
      data: { suiteId, proposals: evaluations.length, accepted: evaluations.filter((e) => e.accepted).length },
    });
    return { baseline, evaluations, applied };
  }

  /**
   * Apply an accepted tune: capture the previous values of every patched key (or the skill's prior
   * status), mutate the live config (and persist it if a writer is wired), toggle the skill if any,
   * and record a versioned, reversible {@link TuneRecord}. Refuses to apply a non-accepted or
   * governance/budget-rejected evaluation.
   */
  applyTune(suiteId: string, evaln: TuneEvaluation): TuneRecord {
    if (!evaln.accepted) throw new Error(`refusing to apply a non-accepted tune: ${evaln.rejectedReason ?? 'rejected'}`);
    const suite = this.store.getSuite(suiteId);
    if (!suite) throw new Error(`unknown suite: ${suiteId}`);
    const p = evaln.proposal;
    const patch = stripInternal(p.patch);
    const previous: Record<string, unknown> = {};

    if (p.kind === 'skill-promote' || p.kind === 'skill-retire') {
      const gov = this.opts.distiller;
      if (!gov || !p.skillId) throw new Error('skill tune requires a distiller and skillId');
      const before = gov.get(p.skillId);
      previous['__skillStatus'] = before?.status ?? 'pending';
      previous['__skillId'] = p.skillId;
      if (p.kind === 'skill-promote') gov.approve(p.skillId);
      else gov.retire(p.skillId, 'tune-accepted');
    } else {
      for (const [key, value] of Object.entries(patch)) {
        previous[key] = getPath(this.config, key);
        setPath(this.config as unknown as Record<string, unknown>, key, value);
        this.opts.persist?.(key, value);
      }
    }

    const rec = this.tunes.record({
      suiteId,
      agent: suite.agent,
      kind: p.kind,
      summary: p.summary,
      patch,
      previous,
      baselineScore: evaln.baselineScore,
      candidateScore: evaln.candidateScore,
      status: 'accepted',
    });
    this.opts.bus?.emit({ type: 'eval.tune.applied', data: { id: rec.id, suiteId, kind: p.kind, version: rec.version } });
    return rec;
  }

  /** The versioned tune history (newest first). */
  listTunes(suiteId?: string, limit?: number): TuneRecord[] {
    return this.tunes.list(suiteId, limit);
  }

  /**
   * Revert an applied tune: restore every patched key to its captured previous value (or restore the
   * skill's prior status), persist, and mark the record reverted. Idempotent.
   */
  revertTune(tuneId: string): TuneRecord {
    const rec = this.tunes.get(tuneId);
    if (!rec) throw new Error(`unknown tune: ${tuneId}`);
    if (rec.reverted) return rec;

    if (rec.kind === 'skill-promote' || rec.kind === 'skill-retire') {
      const gov = this.opts.distiller;
      const skillId = String(rec.previous['__skillId'] ?? '');
      const prevStatus = rec.previous['__skillStatus'];
      if (gov && skillId) {
        if (prevStatus === 'approved') gov.approve(skillId);
        else if (prevStatus === 'retired') gov.retire(skillId, 'tune-reverted');
      }
    } else {
      for (const [key, value] of Object.entries(rec.previous)) {
        if (key.startsWith('__')) continue;
        setPath(this.config as unknown as Record<string, unknown>, key, value);
        this.opts.persist?.(key, value);
      }
    }

    const updated = this.tunes.markReverted(tuneId)!;
    this.opts.bus?.emit({ type: 'eval.tune.reverted', data: { id: tuneId, suiteId: rec.suiteId } });
    return updated;
  }
}

/** Strip internal threading markers (keys starting with `__`) from a patch before exposing it. */
function stripInternal(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!k.startsWith('__')) out[k] = v;
  return out;
}
