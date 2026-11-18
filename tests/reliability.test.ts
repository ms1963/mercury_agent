/**
 * Reliability & efficiency patterns — fully offline and deterministic.
 *
 * Uses an injectable clock (a mutable `clock` variable + `now()` closure) so circuit
 * breaker timings and cache TTLs are exact with no real timers, and a seeded/constant
 * RNG for the retry backoff. No network is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  Saga,
  SagaError,
  runSaga,
  TtlCache,
  SingleFlight,
  retry,
  backoffDelay,
  ProviderError,
} from '@mercury/core';

// A controllable clock for deterministic time-based assertions.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const fail = async (): Promise<never> => {
  throw new ProviderError('boom', 503, true);
};
const ok = async (): Promise<string> => 'ok';

describe('CircuitBreaker', () => {
  it('starts CLOSED and passes successes through', async () => {
    const cb = new CircuitBreaker({ now: fakeClock().now });
    expect(cb.state).toBe('closed');
    await expect(cb.exec(ok)).resolves.toBe('ok');
    expect(cb.metrics.totalSuccesses).toBe(1);
  });

  it('opens after failureThreshold failures and then rejects fast with CircuitOpenError', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });
    for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toBeInstanceOf(ProviderError);
    expect(cb.state).toBe('open');

    // While OPEN the downstream fn is NOT invoked — it rejects fast.
    const spy = vi.fn(fail);
    await expect(cb.exec(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
    expect(cb.metrics.totalShortCircuited).toBe(1);
  });

  it('transitions OPEN -> HALF_OPEN after cooldown and -> CLOSED on success', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 2, cooldownMs: 1000, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    expect(cb.state).toBe('open');

    // Not enough time elapsed yet.
    clock.advance(999);
    await expect(cb.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    // Cooldown elapsed → half-open → one trial success, still half-open (needs 2).
    clock.advance(1);
    await expect(cb.exec(ok)).resolves.toBe('ok');
    expect(cb.state).toBe('half_open');
    // Second success closes it.
    await expect(cb.exec(ok)).resolves.toBe('ok');
    expect(cb.state).toBe('closed');
  });

  it('a failure while HALF_OPEN re-opens immediately', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    expect(cb.state).toBe('open');
    clock.advance(500);
    // Now half-open; a failing trial sends it back to OPEN.
    await expect(cb.exec(fail)).rejects.toBeInstanceOf(ProviderError);
    expect(cb.metrics.state).toBe('open');
    expect(cb.metrics.openedCount).toBe(2);
  });

  it('does not count non-failures (isFailure=false) toward tripping', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      isFailure: (err) => err instanceof ProviderError && err.retryable,
      now: fakeClock().now,
    });
    const notRetryable = async () => {
      throw new ProviderError('bad request', 400, false);
    };
    for (let i = 0; i < 5; i++) await expect(cb.exec(notRetryable)).rejects.toBeInstanceOf(ProviderError);
    expect(cb.state).toBe('closed');
    expect(cb.metrics.totalFailures).toBe(0);
  });

  it('prunes failures outside the rolling window so stale failures do not trip it', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1000, cooldownMs: 100, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    // Two failures within window; advance past window so they age out.
    clock.advance(1001);
    await expect(cb.exec(fail)).rejects.toBeTruthy(); // only 1 within window now
    expect(cb.state).toBe('closed');
  });

  it('reset() forces the breaker back to CLOSED and lets calls through again', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: fakeClock().now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    expect(cb.state).toBe('open');
    cb.reset();
    expect(cb.state).toBe('closed');
    expect(cb.metrics.windowFailures).toBe(0);
    await expect(cb.exec(ok)).resolves.toBe('ok');
  });

  it('accepts resetTimeoutMs as an alias for cooldownMs', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 200, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    clock.advance(199);
    await expect(cb.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError); // cooldown not elapsed
    clock.advance(1);
    await expect(cb.exec(ok)).resolves.toBe('ok'); // trial allowed → closes
  });

  it('CircuitOpenError carries the circuit name, retryAfterMs, code and 503 status', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ name: 'llm', failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy();
    clock.advance(400);
    try {
      await cb.exec(ok);
      throw new Error('expected a CircuitOpenError');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      const ce = err as CircuitOpenError;
      expect(ce.circuit).toBe('llm');
      expect(ce.retryAfterMs).toBe(600); // 1000 cooldown - 400 elapsed
      expect(ce.code).toBe('circuit_open');
      expect(ce.status).toBe(503);
    }
  });

  it('rejects concurrent HALF_OPEN trials beyond halfOpenMaxConcurrent', async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 5, halfOpenMaxConcurrent: 1, cooldownMs: 100, now: clock.now });
    await expect(cb.exec(fail)).rejects.toBeTruthy(); // → open
    clock.advance(100);
    let release: (v: string) => void = () => {};
    const slow = () => new Promise<string>((res) => (release = res));
    const p1 = cb.exec(slow); // moves to half_open; occupies the single trial slot
    expect(cb.state).toBe('half_open');
    // A second concurrent trial is rejected (slot saturated), not executed.
    await expect(cb.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release('done');
    await expect(p1).resolves.toBe('done');
    expect(cb.metrics.totalShortCircuited).toBe(1);
  });

  it('fires onStateChange callbacks for transitions', async () => {
    const clock = fakeClock();
    const changes: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      now: clock.now,
      onStateChange: (c) => changes.push(`${c.from}->${c.to}`),
    });
    await expect(cb.exec(fail)).rejects.toBeTruthy(); // closed->open
    clock.advance(10);
    await expect(cb.exec(ok)).resolves.toBe('ok'); // open->half_open, half_open->closed
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });
});

describe('Saga', () => {
  it('runs all steps and returns accumulated results', async () => {
    const saga = new Saga<{ log: string[] }>()
      .step({ name: 'a', action: async (ctx) => (ctx.log.push('a'), 1) })
      .step({ name: 'b', action: async (ctx) => (ctx.log.push('b'), 2) });
    const { results, ctx } = await saga.run({ log: [] });
    expect(results).toEqual({ a: 1, b: 2 });
    expect(ctx.log).toEqual(['a', 'b']);
  });

  it('compensates completed steps in REVERSE order when a later step fails', async () => {
    const order: string[] = [];
    const saga = new Saga<Record<string, never>>()
      .step({ name: 's1', action: async () => 'r1', compensate: async () => void order.push('comp-s1') })
      .step({ name: 's2', action: async () => 'r2', compensate: async () => void order.push('comp-s2') })
      .step({
        name: 's3',
        action: async () => {
          throw new Error('s3 failed');
        },
      });

    await expect(saga.run({})).rejects.toBeInstanceOf(SagaError);
    // s1 and s2 completed; s3 failed and has no compensation. Reverse order: s2 then s1.
    expect(order).toEqual(['comp-s2', 'comp-s1']);
  });

  it('passes each step its own result to compensate', async () => {
    const seen: Array<[string, unknown]> = [];
    const saga = new Saga()
      .step({ name: 'make', action: async () => ({ id: 42 }), compensate: async (_ctx, r) => void seen.push(['make', r]) })
      .step({
        name: 'explode',
        action: async () => {
          throw new Error('nope');
        },
      });
    await expect(saga.run({})).rejects.toMatchObject({ failedStep: 'explode', code: 'saga_failed' });
    expect(seen).toEqual([['make', { id: 42 }]]);
  });

  it('collects compensation errors without masking the original error', async () => {
    const saga = new Saga()
      .step({
        name: 'first',
        action: async () => 'r',
        compensate: async () => {
          throw new Error('comp failed');
        },
      })
      .step({
        name: 'second',
        action: async () => {
          throw new Error('original');
        },
      });
    try {
      await saga.run({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SagaError);
      const se = err as SagaError;
      expect(se.failedStep).toBe('second');
      expect((se.cause as Error).message).toBe('original');
      expect(se.compensations).toHaveLength(1);
      expect(se.compensations[0]).toMatchObject({ step: 'first', ok: false });
    }
  });

  it('runSaga convenience runs an array of steps', async () => {
    const { results } = await runSaga(
      [
        { name: 'x', action: async () => 10 },
        { name: 'y', action: async () => 20 },
      ],
      {},
    );
    expect(results).toEqual({ x: 10, y: 20 });
  });

  it('emits action/compensation lifecycle events via onEvent', async () => {
    const phases: string[] = [];
    const saga = new Saga<Record<string, never>>({
      name: 'payment',
      onEvent: (e) => phases.push(`${e.phase}:${e.step}`),
    })
      .step({ name: 'reserve', action: async () => 'r', compensate: async () => undefined })
      .step({
        name: 'charge',
        action: async () => {
          throw new Error('declined');
        },
      });
    await expect(saga.run({})).rejects.toBeInstanceOf(SagaError);
    expect(phases).toEqual([
      'action:reserve',
      'action_ok:reserve',
      'action:charge',
      'action_error:charge',
      'compensate:reserve',
      'compensate_ok:reserve',
    ]);
  });

  it('includes the saga name in the error message', async () => {
    const saga = new Saga({ name: 'checkout' }).step({
      name: 'pay',
      action: async () => {
        throw new Error('nope');
      },
    });
    await expect(saga.run({})).rejects.toThrow(/saga 'checkout' step 'pay' failed/);
  });
});

describe('TtlCache', () => {
  it('stores and retrieves values', () => {
    const cache = new TtlCache<string, number>({ now: fakeClock().now });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after their TTL', () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, string>({ ttlMs: 1000, now: clock.now });
    cache.set('k', 'v');
    clock.advance(999);
    expect(cache.get('k')).toBe('v');
    clock.advance(1);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.has('k')).toBe(false);
  });

  it('honors a per-entry TTL override', () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, string>({ ttlMs: 10_000, now: clock.now });
    cache.set('short', 'v', 100);
    clock.advance(101);
    expect(cache.get('short')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over maxSize', () => {
    const cache = new TtlCache<string, number>({ maxSize: 2, now: fakeClock().now });
    cache.set('a', 1);
    cache.set('b', 2);
    // Touch 'a' so 'b' becomes the LRU.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3); // over capacity → evict 'b'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('delete() removes one entry and clear() empties the cache', () => {
    const cache = new TtlCache<string, number>({ now: fakeClock().now });
    cache.set('a', 1).set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false); // already gone
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('b')).toBe(false);
  });

  it('size purges expired entries lazily', () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>({ ttlMs: 100, now: clock.now });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    clock.advance(101);
    expect(cache.size).toBe(0); // both expired and purged on access
  });

  it('wrap() memoizes resolved values by key', async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>({ ttlMs: 1000, now: clock.now });
    const fn = vi.fn(async (n: number) => n * 2);
    const memo = cache.wrap((n: number) => `k${n}`, fn);
    expect(await memo(2)).toBe(4);
    expect(await memo(2)).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1); // second call served from cache
    clock.advance(1001);
    expect(await memo(2)).toBe(4);
    expect(fn).toHaveBeenCalledTimes(2); // expired → recomputed
  });
});

describe('SingleFlight', () => {
  it('coalesces concurrent calls with the same key into one execution', async () => {
    const sf = new SingleFlight<string, number>();
    let calls = 0;
    let resolveFn: (v: number) => void = () => {};
    const slow = () =>
      new Promise<number>((resolve) => {
        calls++;
        resolveFn = resolve;
      });

    const p1 = sf.run('k', slow);
    const p2 = sf.run('k', slow);
    expect(sf.size).toBe(1);
    expect(calls).toBe(1); // second call shared the in-flight promise
    resolveFn(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(sf.size).toBe(0); // key released after settle
  });

  it('propagates a rejection to every coalesced caller and releases the key', async () => {
    const sf = new SingleFlight<string, number>();
    let calls = 0;
    let rejectFn: (e: unknown) => void = () => {};
    const slow = () =>
      new Promise<number>((_resolve, reject) => {
        calls++;
        rejectFn = reject;
      });
    const p1 = sf.run('k', slow);
    const p2 = sf.run('k', slow);
    expect(calls).toBe(1); // coalesced
    expect(sf.has('k')).toBe(true);
    const boom = new Error('boom');
    rejectFn(boom);
    await expect(p1).rejects.toBe(boom);
    await expect(p2).rejects.toBe(boom); // same rejection shared
    expect(sf.has('k')).toBe(false); // key released after settle
    // A fresh call after a failed flight starts new work and can succeed.
    await expect(sf.run('k', async () => 99)).resolves.toBe(99);
  });

  it('runs fresh work after the previous call settles', async () => {
    const sf = new SingleFlight<string, number>();
    let calls = 0;
    const fn = async () => ++calls;
    expect(await sf.run('k', fn)).toBe(1);
    expect(await sf.run('k', fn)).toBe(2); // not in-flight anymore
  });

  it('different keys do not coalesce', async () => {
    const sf = new SingleFlight<string, string>();
    const a = sf.run('a', async () => 'A');
    const b = sf.run('b', async () => 'B');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('wrap() derives the key from arguments', async () => {
    const sf = new SingleFlight<string, number>();
    let calls = 0;
    const wrapped = sf.wrap(
      (n: number) => `k${n}`,
      async (n: number) => {
        calls++;
        return n;
      },
    );
    const [x, y] = await Promise.all([wrapped(5), wrapped(5)]);
    expect([x, y]).toEqual([5, 5]);
    expect(calls).toBe(1);
  });
});

describe('retry wrapper', () => {
  it('returns immediately on success without retrying', async () => {
    const fn = vi.fn(async () => 'done');
    expect(await retry(fn, { retries: 3 })).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to `retries` times then throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    // rng=0 and baseMs=0 → zero-delay backoff, so the test is instant & deterministic.
    await expect(retry(fn, { retries: 2, baseMs: 0, rng: () => 0 })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry when isRetryable returns false', async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError('4xx', 400, false);
    });
    await expect(
      retry(fn, { retries: 5, baseMs: 0, isRetryable: (e) => e instanceof ProviderError && e.retryable }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('eventually succeeds and reports attempts via onRetry', async () => {
    let n = 0;
    const attempts: number[] = [];
    const fn = async () => {
      if (n++ < 2) throw new Error('transient');
      return 'ok';
    };
    const result = await retry(fn, { retries: 5, baseMs: 0, rng: () => 0, onRetry: (i) => attempts.push(i.attempt) });
    expect(result).toBe('ok');
    expect(attempts).toEqual([1, 2]);
  });

  it('stops retrying when the abort signal is already aborted', async () => {
    const fn = vi.fn(async () => {
      throw new Error('transient');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(retry(fn, { retries: 5, baseMs: 0, signal: controller.signal })).rejects.toThrow('transient');
    expect(fn).toHaveBeenCalledTimes(1); // aborted → no further attempts
  });

  it('re-exports the shared backoffDelay (same math, not a reimplementation)', () => {
    expect(backoffDelay(0, 500, 0, () => 1)).toBe(500);
    expect(backoffDelay(2, 500, 0, () => 1)).toBe(2000);
  });
});
