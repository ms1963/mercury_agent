/** Resilience: backoff math, cost accounting, router tagging, and provider retry/fallback via mock fault injection. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@mercury/core';
import { MockProvider, ProviderError, backoffDelay, costOf, inferTags } from '@mercury/core';
import { makeMercury } from './helpers.js';

describe('backoffDelay', () => {
  it('grows exponentially with no jitter', () => {
    expect(backoffDelay(0, 500, 0, () => 1)).toBe(500);
    expect(backoffDelay(1, 500, 0, () => 1)).toBe(1000);
    expect(backoffDelay(2, 500, 0, () => 1)).toBe(2000);
  });

  it('adds up to jitter*exp (rng=1) and nothing at rng=0', () => {
    expect(backoffDelay(0, 500, 0.5, () => 0)).toBe(500);
    expect(backoffDelay(0, 500, 0.5, () => 1)).toBe(750);
    expect(backoffDelay(1, 500, 0.5, () => 1)).toBe(1500);
  });

  it('clamps jitter into 0..1', () => {
    expect(backoffDelay(0, 500, 5, () => 1)).toBe(1000); // jitter clamped to 1
    expect(backoffDelay(0, 500, -5, () => 1)).toBe(500); // jitter clamped to 0
  });

  it('treats negative attempts as attempt 0', () => {
    expect(backoffDelay(-3, 500, 0, () => 1)).toBe(500);
  });
});

describe('costOf', () => {
  it('computes cost from per-1M token rates', () => {
    expect(costOf({ costPer1MInput: 1, costPer1MOutput: 2 }, { inputTokens: 1_000_000, outputTokens: 500_000 })).toBeCloseTo(2);
    expect(costOf({ costPer1MInput: 3, costPer1MOutput: 15 }, { inputTokens: 2_000_000, outputTokens: 1_000_000 })).toBeCloseTo(21);
  });

  it('returns 0 when no profile is known', () => {
    expect(costOf(undefined, { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });
});

describe('router tag inference', () => {
  it('tags code tasks', () => expect(inferTags('please refactor this typescript function')).toContain('code'));
  it('tags reasoning tasks', () => expect(inferTags('analyze why this strategy works')).toContain('reasoning'));
  it('tags writing tasks', () => expect(inferTags('write a short story about the sea')).toContain('writing'));
  it('tags short prompts as fast', () => expect(inferTags('hi')).toContain('fast'));
});

describe('provider retry + fallback (mock fault injection)', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let p: Principal;
  beforeAll(async () => {
    ctx = await makeMercury();
    p = await ctx.m.localPrincipal();
  });
  afterAll(() => ctx.close());

  it('retries a retryable error on the same model and recovers, emitting llm.retry', async () => {
    const mock = ctx.m.providers.get('mock') as MockProvider;
    let threw = 0;
    mock.enqueue(
      () => {
        threw++;
        throw new ProviderError('rate limited', 429, true);
      },
      { content: 'recovered after retry' },
    );
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const off = ctx.m.bus.on('llm.retry', (e) => retries.push(e.data as { attempt: number; delayMs: number }));
    const r = await ctx.m.commands.handle({ principal: p, input: 'trigger a retry please', platform: 'cli' });
    off();
    await ctx.m.agent.idle();
    expect(threw).toBe(1);
    expect(retries.length).toBe(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.delayMs).toBeGreaterThan(0);
    expect(r.output).toContain('recovered after retry');
  });

  it('does not retry a non-retryable error and fails fast (no wasted attempts)', async () => {
    const mock = ctx.m.providers.get('mock') as MockProvider;
    let threw = 0;
    mock.enqueue(() => {
      threw++;
      throw new ProviderError('bad request', 400, false);
    });
    const retries: unknown[] = [];
    const errors: unknown[] = [];
    const offRetry = ctx.m.bus.on('llm.retry', (e) => retries.push(e));
    const offErr = ctx.m.bus.on('llm.error', (e) => errors.push(e));
    const r = await ctx.m.commands.handle({ principal: p, input: 'this request should fail fast', platform: 'cli' });
    offRetry();
    offErr();
    await ctx.m.agent.idle();
    expect(threw).toBe(1); // called exactly once — never retried
    expect(retries.length).toBe(0); // non-retryable → no backoff/retry
    expect(errors.length).toBeGreaterThanOrEqual(1); // the failure was reported on the bus
    expect(r.run?.status).toBe('error'); // surfaced as a clean failure (no model could serve it)
  });
});
