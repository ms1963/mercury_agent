/** Self-evaluation harness: pure scoring, suite selection, and an end-to-end run against the mock agent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@mercury/core';
import { BUILTIN_EVALS, runEvalSuite, scoreTask, selectEvals, type EvalObservation, type EvalTask } from '@mercury/core';
import { makeMercury } from './helpers.js';

const obs = (o: Partial<EvalObservation> = {}): EvalObservation => ({ output: '', toolNames: [], inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0, ...o });
const task = (check: EvalTask['check']): EvalTask => ({ id: 't', prompt: '', description: '', tags: [], check });

describe('scoreTask (pure)', () => {
  it('passes when every condition holds', () => {
    const r = scoreTask(task({ contains: ['hello'], toolCalled: 'calculator' }), obs({ output: 'well, hello', toolNames: ['calculator'] }));
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it('fails with a partial score and explains why', () => {
    const r = scoreTask(task({ contains: ['hello'], toolCalled: 'calculator' }), obs({ output: 'hello there', toolNames: [] }));
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo(0.5);
    expect(r.reasons.join(' ')).toMatch(/calculator/);
  });

  it('honours notContains and regex', () => {
    expect(scoreTask(task({ notContains: ['error'] }), obs({ output: 'all good' })).pass).toBe(true);
    expect(scoreTask(task({ notContains: ['error'] }), obs({ output: 'an error occurred' })).pass).toBe(false);
    expect(scoreTask(task({ regex: '\\d{2}' }), obs({ output: 'answer is 42' })).pass).toBe(true);
  });

  it('fails outright on a run error', () => {
    const r = scoreTask(task({ contains: ['x'] }), obs({ output: 'x', error: 'boom' }));
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/boom/);
  });
});

describe('selectEvals', () => {
  it('returns the whole suite by default', () => expect(selectEvals().length).toBe(BUILTIN_EVALS.length));
  it('filters by tag', () => {
    const mem = selectEvals('memory');
    expect(mem.length).toBeGreaterThan(0);
    expect(mem.every((t) => t.tags.includes('memory'))).toBe(true);
  });
});

describe('self-eval harness end-to-end (mock LLM)', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let p: Principal;
  beforeAll(async () => {
    ctx = await makeMercury();
    p = await ctx.m.localPrincipal();
  });
  afterAll(() => ctx.close());

  const runner = (usage?: Map<string, { i: number; o: number; c: number }>) => async (t: EvalTask): Promise<EvalObservation> => {
    const res = await ctx.m.commands.handle({ principal: p, input: t.prompt, platform: 'cli' });
    const u = usage?.get(res.run?.runId ?? '') ?? { i: 0, o: 0, c: 0 };
    return { output: res.output ?? '', toolNames: res.run?.toolNames ?? [], inputTokens: u.i, outputTokens: u.o, cost: u.c, durationMs: 1 };
  };

  it('passes every built-in task and accounts tokens off the event bus', async () => {
    const usage = new Map<string, { i: number; o: number; c: number }>();
    const off = ctx.m.bus.on('llm.response', (e) => {
      const id = e.runId ?? '';
      const a = usage.get(id) ?? { i: 0, o: 0, c: 0 };
      const d = e.data as { inputTokens?: number; outputTokens?: number; cost?: number };
      a.i += d.inputTokens ?? 0;
      a.o += d.outputTokens ?? 0;
      a.c += d.cost ?? 0;
      usage.set(id, a);
    });
    const report = await runEvalSuite(selectEvals(), runner(usage));
    off();
    expect(report.total).toBeGreaterThanOrEqual(5);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
    expect(report.score).toBe(1);
    expect(report.inputTokens).toBeGreaterThan(0);
  });

  it('runs a tag-filtered subset', async () => {
    const report = await runEvalSuite(selectEvals('memory'), runner());
    expect(report.total).toBeGreaterThan(0);
    expect(report.passed).toBe(report.total);
  });
});
