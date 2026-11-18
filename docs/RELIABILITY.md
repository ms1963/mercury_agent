# Reliability & efficiency patterns

Mercury ships a small, dependency-free toolkit of reliability and efficiency primitives in
`@mercury/core`, under `packages/core/src/reliability/`. They are building blocks: importable from
`@mercury/core` by any package, deterministic in tests (every time/RNG source is injectable), and
free of mock shortcuts in runtime paths.

```ts
import { CircuitBreaker, Saga, TtlCache, SingleFlight, retry, backoffDelay } from '@mercury/core';
```

| Primitive | File | Purpose |
|---|---|---|
| `CircuitBreaker` | `reliability/circuit-breaker.ts` | Fail fast while a dependency is unhealthy |
| `Saga` / `runSaga` | `reliability/saga.ts` | Ordered steps with reverse-order compensation on failure |
| `TtlCache` | `reliability/cache.ts` | Bounded in-memory cache (TTL + LRU) with a `wrap` memoizer |
| `SingleFlight` | `reliability/single-flight.ts` | Coalesce concurrent calls that share a key |
| `retry` / `backoffDelay` | `reliability/retry.ts` | Reuse of the existing exponential-backoff schedule |

---

## CircuitBreaker

A classic three-state breaker:

```
CLOSED ──(failures reach threshold within window)──▶ OPEN
OPEN   ──(after cooldownMs)──▶ HALF_OPEN
HALF_OPEN ──(successThreshold successes)──▶ CLOSED
HALF_OPEN ──(any failure)──▶ OPEN
```

- **CLOSED** — calls flow through; failures are counted in a rolling time window.
- **OPEN** — calls are rejected immediately with a typed `CircuitOpenError` (code `circuit_open`,
  domain `reliability`, HTTP 503) without touching the downstream dependency.
- **HALF_OPEN** — a limited number of trial calls are allowed to probe recovery.

Options: `failureThreshold`, `successThreshold`, `cooldownMs` (alias `resetTimeoutMs`), rolling
`windowMs`, `halfOpenMaxConcurrent`, an `isFailure(err)` predicate (so you can count only
retryable/5xx/network errors and ignore 4xx/validation errors), an injectable `now()` clock, and an
`onStateChange` callback for observability. It exposes `state` and a `metrics` snapshot.

```ts
const breaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 30_000,
  isFailure: (err) => err instanceof ProviderError && err.retryable,
  onStateChange: (c) => bus.emit({ type: 'dep.circuit', data: { from: c.from, to: c.to } }),
});
const result = await breaker.exec(() => callDependency());
```

### Wired into the LLM call path

`LLMService` keeps **one breaker per model id** and wraps the existing retry loop with it
(`packages/core/src/llm/service.ts`). Only genuinely retryable provider errors
(`ProviderError.retryable` — 429/5xx/network) count as failures, so a 4xx/validation error never
trips the breaker. When a model's breaker is open, that model is skipped fast and `chat()` falls
back to the next model in the route; an `llm.circuit_open` event is emitted (and `llm.circuit` on
every state change).

It is fully declarative and backward-compatible — tune or disable it in `config.yaml` with **no code
changes**:

```yaml
llm:
  circuitBreaker:
    enabled: true          # master switch (default true)
    failureThreshold: 5    # retryable failures within the window to open
    cooldownMs: 30000      # time open before a half-open trial
    halfOpenSuccesses: 1   # trial successes needed to close again
    windowMs: 60000        # rolling window for counting failures
```

---

## Saga (compensation / rollback)

A `Saga` runs an ordered list of steps, each `{ name, action, compensate? }`. On success it returns
the accumulated results keyed by step name. If step *k* fails, the already-completed steps *0..k-1*
are compensated in **reverse order** (best-effort): every compensation is attempted even if one
throws, and all compensation errors are collected onto the thrown `SagaError` (code `saga_failed`)
alongside the original `cause` — the original failure is never masked.

```ts
const { results } = await new Saga<Ctx>()
  .step({ name: 'reserve', action: (c) => reserve(c), compensate: (c, r) => cancel(r) })
  .step({ name: 'charge',  action: (c) => charge(c),  compensate: (c, r) => refund(r) })
  .step({ name: 'ship',    action: (c) => ship(c) })
  .run(ctx);
// If `ship` throws: charge is refunded, then reserve is cancelled (reverse order).
```

---

## Retry & backoff (existing, reused)

Retry timing across Mercury comes from a single source of truth: `backoffDelay(attempt, baseMs,
jitter, rng)` in `packages/core/src/llm/backoff.ts` (exponential growth + bounded jitter, injectable
RNG). The `LLMService` retry loop uses it directly. For everything else, the reliability module adds
a thin `retry(fn, { retries, baseMs, jitter, isRetryable, signal, rng, onRetry })` wrapper that
**composes** `backoffDelay` — it does not reimplement the math. `backoffDelay` is re-exported from the
reliability surface for convenience.

```ts
const data = await retry(() => fetchThing(), {
  retries: 3,
  isRetryable: (e) => e instanceof ProviderError && e.retryable,
});
```

---

## TTL cache

`TtlCache<K, V>` is a small generic in-memory cache with per-entry TTL and bounded size (LRU
eviction via `Map` insertion order). Methods: `get`, `set` (with optional per-entry TTL override),
`has`, `delete`, `clear`, `size`, and `wrap(keyFn, fn, ttl)` to memoize an async function's resolved
values. The clock is injectable for deterministic expiry in tests.

```ts
const cache = new TtlCache<string, Model[]>({ maxSize: 500, ttlMs: 60_000 });
const listModels = cache.wrap(() => 'models', () => provider.listModels());
```

---

## Single-flight / request coalescing

`SingleFlight<K, V>` deduplicates concurrent calls that share a key: only one underlying promise runs
in-flight, and all callers that arrive while it runs share the result. Once it settles, the key is
released so the next call starts fresh work. Pair it with `TtlCache` when you also want the settled
result reused over time.

```ts
const sf = new SingleFlight<string, Token>();
const token = await sf.run('refresh', () => refreshAuthToken()); // N concurrent callers → 1 refresh
```

---

## Tested vs untested

Consistent with [STATUS.md](../STATUS.md): the primitives and their edge cases are covered by the
offline, deterministic vitest suite (`tests/reliability.test.ts`) — circuit-breaker state
transitions (open/half-open/close, cooldown, rolling-window pruning, non-failure predicate), saga
success and reverse-order compensation (including compensation-error collection), TTL cache expiry +
LRU eviction + memoization, single-flight dedup, and the retry wrapper. The LLM-path wiring reuses
the existing, tested retry loop and is exercised indirectly by the resilience tests. None of this has
been run against a real external LLM provider.
