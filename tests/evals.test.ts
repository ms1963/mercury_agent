/**
 * Feature — Evaluation-driven self-improvement (closed evals + governed auto-tune).
 *
 * Exercised against the real subsystems (SQLite eval + tune stores, the pure scorer, the governed
 * tuner and the EvalService) with a deterministic in-test runner (test-only — no product-code
 * mocks). Covers:
 *   - promote a real run (runs + events rows) into a labeled eval case with derived tools/output,
 *   - replay a suite into a deterministic, persisted score time series,
 *   - the governed auto-tuner ACCEPTS an improving proposal and REJECTS a non-improving one,
 *   - governance (protected keys) and the per-task budget ceiling are enforced during tuning,
 *   - an accepted tune is versioned and reversible (config restored on revert).
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  Db,
  EvalService,
  SqliteEvalStore,
  SqliteTuneStore,
  aggregateScore,
  scoreCase,
  textSimilarity,
  violatesGovernance,
  type EvalCase,
  type EvalCaseRunner,
  type MercuryConfig,
  type TuneProposal,
} from '@mercury/core';

function freshConfig(over: Record<string, unknown> = {}): MercuryConfig {
  const cfg = ConfigSchema.parse({});
  // Keep the per-task budget tight so the budget guard is easy to exercise deterministically.
  cfg.evals.costCeiling = 0.05;
  cfg.agent.temperature = 0.7;
  Object.assign(cfg.evals, over);
  return cfg;
}

/**
 * A deterministic runner whose observed quality is a pure function of the per-run overrides, so a
 * proposal's effect on the score is fully controllable:
 *   - baseline (no overrides): wrong output, no tool → fails the case.
 *   - temperature 0.1: perfect output + tool, cheap → passes (the improving proposal).
 *   - temperature 0.9: still wrong → no improvement (the regressing proposal).
 *   - model "pricey": perfect output but very expensive → blows the budget ceiling.
 */
const controlledRunner: EvalCaseRunner = async (_c, o) => {
  const base = { toolNames: [] as string[], inputTokens: 10, outputTokens: 10, durationMs: 1 };
  if (o?.temperature === 0.1) return { ...base, output: 'the answer is 42', toolNames: ['calc'], cost: 0.001 };
  if (o?.model === 'pricey') return { ...base, output: 'the answer is 42', toolNames: ['calc'], cost: 0.9 };
  // baseline and the regressing temperature 0.9 both produce a wrong, tool-less result.
  return { ...base, output: 'i am not sure', cost: 0.002 };
};

function service(cfg: MercuryConfig, runner: EvalCaseRunner = controlledRunner) {
  const db = new Db(':memory:');
  const evals = new EvalService(new SqliteEvalStore(db), new SqliteTuneStore(db), cfg, runner, db);
  return { db, evals };
}

/** Seed a suite with one well-specified case (expects a tool, text and a reference output). */
function seedSuite(evals: EvalService) {
  const suite = evals.createSuite('router-quality', 'default', 'quality gate');
  evals.addCase({
    suiteId: suite.id,
    name: 'answer-42',
    input: 'What is 6 times 7?',
    expected: { tools: ['calc'], contains: ['answer'], output: 'the answer is 42', maxCost: 0.05 },
  });
  return suite;
}

describe('evals — scorer (pure, deterministic)', () => {
  const mkCase = (expected: EvalCase['expected']): EvalCase => ({
    id: 'c1', suiteId: 's1', name: 'c', input: 'i', expected, tags: [], createdAt: '', updatedAt: '',
  });

  it('passes only when every declared condition holds', () => {
    const c = mkCase({ tools: ['calc'], contains: ['answer'], output: 'the answer is 42', maxCost: 0.05 });
    const good = scoreCase(c, { output: 'the answer is 42', toolNames: ['calc'], inputTokens: 1, outputTokens: 1, cost: 0.001, durationMs: 1 });
    expect(good.pass).toBe(true);
    expect(good.similarity).toBe(1);
    const bad = scoreCase(c, { output: 'no idea', toolNames: [], inputTokens: 1, outputTokens: 1, cost: 0.2, durationMs: 1 });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.length).toBeGreaterThan(0);
  });

  it('counts an errored run as an intervention and a fail', () => {
    const c = mkCase({});
    const r = scoreCase(c, { output: '', toolNames: [], inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 1, error: 'blocked' });
    expect(r.pass).toBe(false);
    expect(r.intervened).toBe(true);
  });

  it('aggregate score is a normalized 0..1 blend', () => {
    const results = [
      { id: 'a', name: 'a', pass: true, cost: 0.001, similarity: 1, intervened: false, reasons: ['ok'] },
      { id: 'b', name: 'b', pass: false, cost: 0.002, similarity: 0, intervened: false, reasons: ['x'] },
    ];
    const agg = aggregateScore('s', 'default', results, { passRate: 0.5, cost: 0.2, intervention: 0.15, similarity: 0.15 }, 0.05);
    expect(agg.passRate).toBe(0.5);
    expect(agg.score).toBeGreaterThan(0);
    expect(agg.score).toBeLessThanOrEqual(1);
  });

  it('textSimilarity is 1 for identical and 0 for disjoint', () => {
    expect(textSimilarity('alpha beta', 'alpha beta')).toBe(1);
    expect(textSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
});

describe('evals — promote a real run into a case', () => {
  it('derives expected tools and output from the run log', () => {
    const { db, evals } = service(freshConfig());
    const runId = 'run-abc123456789';
    db.run(
      'INSERT INTO runs (id, kind, status, input, output, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      runId, 'chat', 'completed', 'Add 1200 and 3400', 'The total is 4600.', 'mock/fast', new Date().toISOString(),
    );
    for (const name of ['calculator', 'calculator', 'formatter']) {
      db.run(
        'INSERT INTO events (id, run_id, type, ts, data) VALUES (?, ?, ?, ?, ?)',
        'ev-' + Math.random().toString(36).slice(2), runId, 'tool.call', new Date().toISOString(), JSON.stringify({ name }),
      );
    }
    const suite = evals.createSuite('promoted', 'default');
    const c = evals.promoteRun(runId, { suiteId: suite.id, name: 'addition' });
    expect(c.input).toBe('Add 1200 and 3400');
    expect(c.sourceRunId).toBe(runId);
    // Tools are de-duplicated, order preserved; output captured as the reference.
    expect(c.expected.tools).toEqual(['calculator', 'formatter']);
    expect(c.expected.output).toBe('The total is 4600.');
    expect(evals.listCases(suite.id)).toHaveLength(1);
  });

  it('refuses to promote an unknown run', () => {
    const { evals } = service(freshConfig());
    expect(() => evals.promoteRun('does-not-exist')).toThrow(/unknown run/);
  });
});

describe('evals — deterministic suite scoring', () => {
  it('records a persisted score point and charts the trend', async () => {
    const { evals } = service(freshConfig());
    const suite = seedSuite(evals);

    // Baseline runner fails the case → low score.
    const low = await evals.runSuite(suite.id, { label: 'baseline' });
    expect(low.cases).toBe(1);
    expect(low.passRate).toBe(0);

    const trend = evals.trend(suite.id);
    expect(trend).toHaveLength(1);
    expect(trend[0].label).toBe('baseline');
    expect(trend[0].score).toBeCloseTo(low.score, 5);

    // A dry run does not add a point.
    await evals.runSuite(suite.id, { dryRun: true });
    expect(evals.trend(suite.id)).toHaveLength(1);

    // The same inputs produce the same score (determinism).
    const again = await evals.runSuite(suite.id, { dryRun: true });
    expect(again.score).toBeCloseTo(low.score, 10);
  });
});

describe('evals — governed auto-tune', () => {
  const improving: TuneProposal = { kind: 'temperature', summary: 'lower temp → 0.1', patch: { 'agent.temperature': 0.1 } };
  const regressing: TuneProposal = { kind: 'temperature', summary: 'raise temp → 0.9', patch: { 'agent.temperature': 0.9 } };
  const overBudget: TuneProposal = { kind: 'model-routing', summary: 'use pricey model', patch: { 'agent.model': 'pricey' } };
  const governance: TuneProposal = { kind: 'prompt', summary: 'weaken a policy', patch: { 'security.policies': [] } };

  it('accepts an improving proposal and rejects a non-improving one', async () => {
    const { evals } = service(freshConfig());
    const suite = seedSuite(evals);
    const res = await evals.proposeTune(suite.id, [improving, regressing]);

    const imp = res.evaluations.find((e) => e.proposal.summary.includes('0.1'))!;
    const reg = res.evaluations.find((e) => e.proposal.summary.includes('0.9'))!;
    expect(imp.accepted).toBe(true);
    expect(imp.improvement).toBeGreaterThan(0);
    expect(reg.accepted).toBe(false);
    expect(reg.improvement).toBeLessThanOrEqual(0);
    // Dry run by default (autotune off) — nothing auto-applied.
    expect(res.applied).toHaveLength(0);
  });

  it('enforces the per-task budget ceiling even for a would-be improvement', async () => {
    const { evals } = service(freshConfig());
    const suite = seedSuite(evals);
    const res = await evals.proposeTune(suite.id, [overBudget]);
    const e = res.evaluations[0];
    expect(e.accepted).toBe(false);
    expect(e.rejectedReason).toMatch(/budget/i);
  });

  it('rejects a proposal that touches a governance-protected key', async () => {
    const { evals } = service(freshConfig());
    const suite = seedSuite(evals);
    expect(violatesGovernance(governance)).toBe(true);
    const res = await evals.proposeTune(suite.id, [governance]);
    const e = res.evaluations[0];
    expect(e.accepted).toBe(false);
    expect(e.rejectedReason).toMatch(/governance/i);
  });

  it('auto-applies accepted proposals only when enabled AND autoApply', async () => {
    const { evals } = service(freshConfig({ autotune: { enabled: true, autoApply: true, minImprovement: 0.02, maxProposals: 8 } }));
    const suite = seedSuite(evals);
    const res = await evals.proposeTune(suite.id, [improving, regressing]);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].kind).toBe('temperature');
  });

  it('an accepted tune is versioned and reversible', async () => {
    const cfg = freshConfig();
    const { evals } = service(cfg);
    const suite = seedSuite(evals);
    const res = await evals.proposeTune(suite.id, [improving]);
    const evaln = res.evaluations[0];
    expect(evaln.accepted).toBe(true);

    const before = cfg.agent.temperature;
    const rec = evals.applyTune(suite.id, evaln);
    expect(rec.version).toBe(1);
    expect(rec.reverted).toBe(false);
    expect(cfg.agent.temperature).toBe(0.1);
    expect(rec.previous['agent.temperature']).toBe(before);

    // A second accepted tune gets the next version number.
    const rec2 = evals.applyTune(suite.id, evaln);
    expect(rec2.version).toBe(2);

    // Revert restores the value captured just before that record was applied, and
    // marks the record reverted (idempotent). rec2 captured the already-tuned 0.1.
    const reverted = evals.revertTune(rec2.id);
    expect(reverted.reverted).toBe(true);
    expect(cfg.agent.temperature).toBe(rec2.previous['agent.temperature']);
    expect(evals.revertTune(rec2.id).reverted).toBe(true);
    // Reverting the first record too restores the original pre-tune value.
    evals.revertTune(rec.id);
    expect(cfg.agent.temperature).toBe(before);

    expect(evals.listTunes(suite.id).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to apply a non-accepted evaluation', async () => {
    const { evals } = service(freshConfig());
    const suite = seedSuite(evals);
    const res = await evals.proposeTune(suite.id, [regressing]);
    expect(() => evals.applyTune(suite.id, res.evaluations[0])).toThrow(/non-accepted/);
  });
});
