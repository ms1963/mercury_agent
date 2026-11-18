/**
 * Reliability & efficiency patterns for Mercury.
 *
 * - {@link CircuitBreaker} — three-state breaker that fails fast on unhealthy deps.
 * - {@link Saga} — ordered steps with reverse-order compensation on failure.
 * - {@link TtlCache} — bounded, TTL-aware in-memory cache (LRU eviction) + memoizer.
 * - {@link SingleFlight} — coalesces concurrent calls sharing a key.
 * - {@link retry} / {@link backoffDelay} — reuse of the existing backoff schedule.
 */
export * from './circuit-breaker.js';
export * from './saga.js';
export * from './cache.js';
export * from './single-flight.js';
export * from './retry.js';
