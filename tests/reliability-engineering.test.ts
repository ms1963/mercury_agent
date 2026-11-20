/**
 * Feature — Reliability engineering.
 *
 * Covers chaos fault injection (off by default, deterministic with a seed, tool-glob eligibility,
 * and real injection into the tool path), record/replay regression (recording a real run and
 * replaying it through the live agent with an outcome diff) and per-agent SLOs computed from the
 * real run history. Uses the mock LLM via isolated Mercury instances; no product-code mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChaosController, ConfigSchema, type Principal } from '@mercury/core';
import { makeMercury } from './helpers.js';

const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse(o);

describe('ChaosController', () => {
  it('is inert when disabled (default)', () => {
    const c = new ChaosController(cfg());
    expect(c.enabled).toBe(false);
    expect(c.decide('anything')).toBeNull();
    expect(c.status().enabled).toBe(false);
  });

  it('injects failures deterministically with a seed and counts them', () => {
    const c = new ChaosController(cfg({ reliability: { chaos: { enabled: true, failureProbability: 1, seed: 7 } } }));
    expect(c.decide('web.fetch')).toBe('fail');
    expect(c.decide('fs.read')).toBe('fail');
    expect(c.injections).toBe(2);
  });

  it('injects timeouts when only timeoutProbability is set', () => {
    const c = new ChaosController(cfg({ reliability: { chaos: { enabled: true, timeoutProbability: 1, seed: 1 } } }));
    expect(c.decide('x')).toBe('timeout');
  });

  it('respects the tool glob allowlist', () => {
    const c = new ChaosController(cfg({ reliability: { chaos: { enabled: true, failureProbability: 1, tools: ['web.*'], seed: 1 } } }));
    expect(c.decide('web.fetch')).toBe('fail');
    expect(c.decide('calculator')).toBeNull();
  });

  it('is reproducible across two controllers with the same seed', () => {
    const mk = () => new ChaosController(cfg({ reliability: { chaos: { enabled: true, failureProbability: 0.5, seed: 99 } } }));
    const a = mk();
    const b = mk();
    const seqA = Array.from({ length: 10 }, () => a.decide('t'));
    const seqB = Array.from({ length: 10 }, () => b.decide('t'));
    expect(seqA).toEqual(seqB);
  });
});

describe('chaos — real injection into the tool path', () => {
  it('fails an eligible tool call and emits chaos.injected', async () => {
    const { m, close } = await makeMercury({ reliability: { chaos: { enabled: true, failureProbability: 1, seed: 3 } } });
    try {
      const p = await m.localPrincipal();
      const injected: unknown[] = [];
      const off = m.bus.on('chaos.injected', (e) => void injected.push(e.data));
      const r = await m.commands.handle({ principal: p, input: 'call:calculator {"expression":"2*21"}', platform: 'cli' });
      off();
      expect(injected.length).toBeGreaterThanOrEqual(1);
      expect(m.chaos.injections).toBeGreaterThanOrEqual(1);
      // the normal calculator result (42) must NOT be present — the call was forced to fail.
      expect(r.output).not.toContain('42');
    } finally {
      await close();
    }
  });
});

describe('record / replay regression', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let p: Principal;
  beforeAll(async () => {
    ctx = await makeMercury({ reliability: { record: true } });
    p = await ctx.m.localPrincipal();
  });
  afterAll(() => ctx.close());

  it('auto-records completed runs when reliability.record is on', async () => {
    const r = await ctx.m.commands.handle({ principal: p, input: 'call:calculator {"expression":"6*7"}', platform: 'cli' });
    expect(r.run?.status).toBe('completed');
    const recs = ctx.m.runRecorder.list();
    const mine = recs.find((x) => x.runId === r.run?.runId);
    expect(mine).toBeDefined();
    expect(mine?.toolCalls.map((t) => t.name)).toContain('calculator');
  });

  it('records a run on demand and replays it with an outcome diff', async () => {
    const r = await ctx.m.commands.handle({ principal: p, input: 'Hello there', platform: 'cli' });
    const rec = ctx.m.runRecorder.record(r.run!.runId, 'greeting');
    expect(rec?.name).toBe('greeting');
    const diff = await ctx.m.replay.replay(rec!.id);
    expect(diff.statusMatch).toBe(true);
    expect(diff.toolMatch).toBe(true);
    // deterministic mock → identical output → high similarity, no regression.
    expect(diff.outputSimilarity).toBeGreaterThan(0.8);
    expect(diff.match).toBe(true);
  });

  it('removes a recording', () => {
    const rec = ctx.m.runRecorder.list()[0];
    expect(ctx.m.runRecorder.remove(rec.id)).toBe(true);
    expect(ctx.m.runRecorder.get(rec.id)).toBeUndefined();
  });
});

describe('SloService', () => {
  it('computes per-agent SLOs from real run history', async () => {
    const { m, close } = await makeMercury();
    try {
      const p = await m.localPrincipal();
      for (let i = 0; i < 3; i++) await m.commands.handle({ principal: p, input: `ping ${i}`, platform: 'cli' });
      const report = m.slo.compute();
      expect(report.windowDays).toBeGreaterThan(0);
      expect(report.targets.targetSuccessRate).toBeGreaterThan(0);
      const total = report.agents.reduce((s, a) => s + a.runs, 0);
      expect(total).toBeGreaterThanOrEqual(3);
      for (const a of report.agents) {
        expect(a.successRate).toBeGreaterThanOrEqual(0);
        expect(a.successRate).toBeLessThanOrEqual(1);
        expect(typeof a.meetsSuccess).toBe('boolean');
      }
    } finally {
      await close();
    }
  });
});
