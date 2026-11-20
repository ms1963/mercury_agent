/**
 * Feature 2 — Economics & routing.
 *
 * Covers the cheapest-model-likely-to-succeed selection (difficulty inference, price proxy,
 * lane gating and fallback), the hard per-task budget service (open/record/check/complete,
 * escalate vs halt, cost-vs-value projection math and pruning) and the end-to-end per-task
 * halt wired through a real Mercury instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  EventBus,
  TaskBudgetExceededError,
  TaskBudgetService,
  inferDifficulty,
  normalizeProfile,
  profilePrice,
  selectCheapestSufficient,
  type ModelProfile,
} from '@mercury/core';
import { makeMercury } from './helpers.js';

const cfg = (overrides: Record<string, unknown> = {}) => ConfigSchema.parse(overrides);

const prof = (id: string, p: Partial<ModelProfile>): ModelProfile => normalizeProfile({ id, ...p });

describe('inferDifficulty', () => {
  it('scores greetings/lookups low (local lane territory)', () => {
    expect(inferDifficulty('hi')).toBeLessThanOrEqual(0.3);
    expect(inferDifficulty('what time is it')).toBeLessThan(0.4);
  });

  it('scores reasoning/code/math tasks high (frontier territory)', () => {
    expect(inferDifficulty('prove this theorem and analyze the trade-offs step by step')).toBeGreaterThan(0.55);
    expect(inferDifficulty('refactor this TypeScript function and fix the bug')).toBeGreaterThan(0.35);
    expect(inferDifficulty('solve the integral of this matrix equation')).toBeGreaterThan(0.35);
  });

  it('respects explicit tags and long inputs', () => {
    expect(inferDifficulty('do it', ['reasoning'])).toBeGreaterThan(inferDifficulty('do it'));
    expect(inferDifficulty('x'.repeat(700))).toBeGreaterThan(inferDifficulty('x'.repeat(10)));
  });

  it('is clamped to 0..1 and deterministic', () => {
    const v = inferDifficulty('prove reason analyze derive optimize architect strategy complex', ['reasoning', 'code']);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(inferDifficulty('same task')).toBe(inferDifficulty('same task'));
  });
});

describe('profilePrice', () => {
  it('sums input+output list price', () => {
    expect(profilePrice(prof('m', { costPer1MInput: 3, costPer1MOutput: 15 }))).toBe(18);
    expect(profilePrice(prof('local', { costPer1MInput: 0, costPer1MOutput: 0 }))).toBe(0);
  });
});

describe('selectCheapestSufficient', () => {
  const local = prof('ollama/x', { quality: 0.55, lane: 'local', costPer1MInput: 0, costPer1MOutput: 0, latencyMs: 2500 });
  const mini = prof('gpt-4o-mini', { quality: 0.7, lane: 'frontier', costPer1MInput: 0.15, costPer1MOutput: 0.6, latencyMs: 800 });
  const big = prof('sonnet', { quality: 0.92, lane: 'frontier', costPer1MInput: 3, costPer1MOutput: 15, latencyMs: 2000 });
  const pool = [big, mini, local];

  it('returns null for an empty pool', () => {
    expect(selectCheapestSufficient([], 0.3, { localMaxDifficulty: 0.55, qualityMargin: 0 })).toBeNull();
  });

  it('routes a routine task to the cheapest (local) sufficient model', () => {
    const r = selectCheapestSufficient(pool, 0.4, { localMaxDifficulty: 0.55, qualityMargin: 0 })!;
    expect(r.chosen.id).toBe('ollama/x');
    expect(r.reason).toContain('local');
  });

  it('excludes the local lane for hard tasks even if its quality nominally clears the bar', () => {
    // need just above localMaxDifficulty → local lane excluded; cheapest frontier wins.
    const r = selectCheapestSufficient(pool, 0.6, { localMaxDifficulty: 0.55, qualityMargin: 0 })!;
    expect(r.chosen.id).toBe('gpt-4o-mini');
    expect(r.chosen.lane).toBe('frontier');
  });

  it('picks the cheapest model that still meets the quality need', () => {
    const r = selectCheapestSufficient(pool, 0.9, { localMaxDifficulty: 0.55, qualityMargin: 0 })!;
    expect(r.chosen.id).toBe('sonnet');
  });

  it('applies a quality margin when selecting', () => {
    // need 0.68 + margin 0.1 = 0.78 → mini (0.7) no longer sufficient, sonnet wins.
    const r = selectCheapestSufficient(pool, 0.68, { localMaxDifficulty: 0.55, qualityMargin: 0.1 })!;
    expect(r.chosen.id).toBe('sonnet');
  });

  it('falls back to the highest-quality model when nothing meets the bar', () => {
    const r = selectCheapestSufficient([mini, local], 0.99, { localMaxDifficulty: 0.55, qualityMargin: 0 })!;
    expect(r.chosen.id).toBe('gpt-4o-mini');
    expect(r.reason).toContain('best available');
  });
});

describe('TaskBudgetService', () => {
  it('opens a task with caps defaulted from config and explicit limits winning', () => {
    const svc = new TaskBudgetService(cfg({ budgets: { perTask: { maxCost: 1, projectedSteps: 4 } } }));
    const a = svc.open('t1');
    expect(a.limits.maxCost).toBe(1);
    expect(a.limits.projectedSteps).toBe(4);
    const b = svc.open('t2', { maxCost: 5, valueEstimate: 10 });
    expect(b.limits.maxCost).toBe(5);
    expect(b.limits.valueEstimate).toBe(10);
    expect(svc.active().map((t) => t.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('records spend and reports it back', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxCost: 10 });
    svc.record('t', 0.25, 1000, 500);
    const t = svc.get('t')!;
    expect(t.cost).toBeCloseTo(0.25);
    expect(t.inputTokens).toBe(1000);
    expect(t.outputTokens).toBe(500);
    expect(t.calls).toBe(1);
  });

  it('check() throws TaskBudgetExceededError when a prospective call would exceed the cost cap', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxCost: 1 });
    svc.record('t', 0.9);
    expect(() => svc.check('t', 0.2)).toThrow(TaskBudgetExceededError);
    expect(svc.get('t')!.state).toBe('escalated');
  });

  it('check() throws on token-cap exceed', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxTokens: 1000 });
    svc.record('t', 0, 600, 300);
    expect(() => svc.check('t', 0, 200)).toThrow(TaskBudgetExceededError);
  });

  it('check() is a no-op on override, disabled config, or unknown task', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxCost: 1 });
    svc.record('t', 2); // already over
    expect(() => svc.check('t', 0.1, 0, true)).not.toThrow(); // override
    const disabled = new TaskBudgetService(cfg({ budgets: { perTask: { enabled: false } } }));
    disabled.open('t', { maxCost: 1 });
    disabled.record('t', 5);
    expect(() => disabled.check('t', 1)).not.toThrow();
    expect(() => svc.check('unknown', 100)).not.toThrow();
  });

  it('halts (not escalates) when configured onExceed=halt, via record()', () => {
    const svc = new TaskBudgetService(cfg({ budgets: { perTask: { onExceed: 'halt' } } }));
    svc.open('t', { maxCost: 1 });
    svc.record('t', 1.5);
    expect(svc.get('t')!.state).toBe('halted');
    expect(svc.get('t')!.reason).toContain('cost budget exceeded');
  });

  it('emits task.budget.exceeded on the bus when it trips', () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on('task.budget.exceeded', (e) => events.push(String((e.data as { state?: string }).state)));
    const svc = new TaskBudgetService(cfg(), bus);
    svc.open('t', { maxCost: 1 });
    svc.record('t', 2);
    expect(events).toEqual(['escalated']);
  });

  it('computes the cost-vs-value estimate with projection, ratio and budget fraction', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxCost: 2, valueEstimate: 5, projectedSteps: 4 });
    svc.record('t', 0.5, 100, 100); // 1 call so far, projects to 4 steps → 2.0
    const cv = svc.costVsValue('t')!;
    expect(cv.costSoFar).toBeCloseTo(0.5);
    expect(cv.projectedCost).toBeCloseTo(2.0);
    expect(cv.valueEstimate).toBe(5);
    expect(cv.valueRatio).toBeCloseTo(2.5); // 5 / 2.0
    expect(cv.budgetUsedFraction).toBeCloseTo(0.25); // 0.5 / 2
    expect(cv.overBudget).toBe(false);
  });

  it('flags overBudget when projected cost exceeds the task value', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { valueEstimate: 1, projectedSteps: 10 });
    svc.record('t', 0.5); // projects to 5.0 >> value 1
    expect(svc.costVsValue('t')!.overBudget).toBe(true);
  });

  it('projects no higher than actual cost once a task is completed', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { projectedSteps: 10 });
    svc.record('t', 0.5);
    svc.complete('t');
    const cv = svc.costVsValue('t')!;
    expect(cv.state).toBe('completed');
    expect(cv.projectedCost).toBeCloseTo(0.5);
  });

  it('complete() leaves halted/escalated states intact', () => {
    const svc = new TaskBudgetService(cfg());
    svc.open('t', { maxCost: 1 });
    svc.record('t', 2);
    svc.complete('t');
    expect(svc.get('t')!.state).toBe('escalated');
  });

  it('prunes finished tasks older than the cutoff', () => {
    const svc = new TaskBudgetService(cfg());
    const t = svc.open('t', { maxCost: 1 });
    svc.complete('t');
    t.startedAt = new Date(Date.now() - 10_000_000).toISOString();
    expect(svc.prune(3_600_000)).toBe(1);
    expect(svc.get('t')).toBeUndefined();
  });

  it('attach() opens on run.start and completes on run.end', () => {
    const bus = new EventBus();
    const svc = new TaskBudgetService(cfg());
    const off = svc.attach(bus);
    bus.emit({ type: 'run.start', runId: 'r1', data: { input: 'hi', taskBudget: { maxCost: 3 } } });
    expect(svc.get('r1')!.limits.maxCost).toBe(3);
    bus.emit({ type: 'run.end', runId: 'r1', data: { status: 'ok' } });
    expect(svc.get('r1')!.state).toBe('completed');
    off();
  });
});

describe('economics — end-to-end routing + per-task halt', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  beforeAll(async () => {
    ctx = await makeMercury();
  });
  afterAll(() => ctx.close());

  it('route() returns a lane and quality need', async () => {
    const d = await ctx.m.router.route({ task: 'hello there' });
    expect(d.model).toBeTruthy();
    expect(typeof d.qualityNeed).toBe('number');
  });

  it('exposes the task budget service on the instance', () => {
    expect(ctx.m.taskBudgets).toBeInstanceOf(TaskBudgetService);
    const t = ctx.m.taskBudgets.open('manual', { maxCost: 1, valueEstimate: 2 });
    expect(t.state).toBe('active');
    expect(ctx.m.taskBudgets.costVsValue('manual')!.taskId).toBe('manual');
  });
});
