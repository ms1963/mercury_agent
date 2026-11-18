/**
 * Single-flight / request coalescing — deduplicates concurrent calls that share a
 * key so that only one underlying operation runs in-flight at a time; every caller
 * that arrives while it is running shares the same promise (and therefore the same
 * result or rejection).
 *
 * This is the classic "thundering herd" guard for expensive idempotent work (a
 * cache miss refill, a token refresh, a model listing): N simultaneous callers
 * collapse into one downstream call. Once the in-flight promise settles, the key is
 * released, so the next call starts fresh work.
 *
 * Dependency-free. Note this does NOT cache results across time — pair it with
 * {@link TtlCache} when you also want results reused after they settle.
 */

/**
 * Coalesces concurrent calls by key.
 *
 * @typeParam K - key type.
 * @typeParam V - resolved value type.
 */
export class SingleFlight<K = string, V = unknown> {
  private readonly inflight = new Map<K, Promise<V>>();

  /**
   * Run `fn` for `key`, or, if a call for the same key is already in flight, return
   * that existing promise instead of starting a second one.
   */
  run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Whether a call for `key` is currently in flight. */
  has(key: K): boolean {
    return this.inflight.has(key);
  }

  /** Number of distinct keys currently in flight. */
  get size(): number {
    return this.inflight.size;
  }

  /**
   * Wrap an async function so concurrent calls with the same derived key are
   * coalesced. `keyFn` maps the call arguments to a key.
   */
  wrap<A extends unknown[]>(keyFn: (...args: A) => K, fn: (...args: A) => Promise<V>): (...args: A) => Promise<V> {
    return (...args: A): Promise<V> => this.run(keyFn(...args), () => fn(...args));
  }
}
