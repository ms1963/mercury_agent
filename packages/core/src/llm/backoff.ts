/**
 * Retry backoff with exponential growth and bounded jitter.
 *
 * The delay for a zero-based `attempt` is `base * 2^attempt`, plus a random
 * component of up to `jitter` (0..1) times that exponential term. Jitter spreads
 * out concurrent retries so a recovering provider is not hammered in lock-step
 * ("thundering herd"). The RNG is injectable so the behaviour is fully
 * deterministic in tests.
 *
 *   base=500, jitter=0.5, attempt=0 → 500..750ms
 *   base=500, jitter=0.5, attempt=1 → 1000..1500ms
 *   base=500, jitter=0.5, attempt=2 → 2000..3000ms
 */
export function backoffDelay(attempt: number, baseMs = 500, jitter = 0.5, rng: () => number = Math.random): number {
  const exp = baseMs * 2 ** Math.max(0, attempt);
  const clampedJitter = Math.min(1, Math.max(0, jitter));
  const spread = exp * clampedJitter * rng();
  return Math.round(exp + spread);
}
