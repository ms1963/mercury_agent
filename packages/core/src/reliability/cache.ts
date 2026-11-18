/**
 * TTL cache — a small, generic, in-memory cache with per-entry time-to-live and
 * bounded size (LRU eviction). Dependency-free; the clock is injectable so expiry
 * is deterministic in tests.
 *
 * Recency is tracked using `Map` insertion order: reads and writes move an entry to
 * the most-recently-used position, so the first key in the map is always the LRU
 * victim when `maxSize` is exceeded.
 */

/** Construction options for {@link TtlCache}. */
export interface TtlCacheOptions {
  /** Maximum number of live entries; least-recently-used are evicted. Default 1000. */
  maxSize?: number;
  /** Default time-to-live (ms) applied when `set` is called without one. Default: no expiry. */
  ttlMs?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  /** Absolute expiry time (ms); `Infinity` means never. */
  expiresAt: number;
}

/**
 * A bounded, TTL-aware in-memory cache.
 *
 * @typeParam K - key type (anything usable as a `Map` key).
 * @typeParam V - stored value type.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxSize: number;
  private readonly defaultTtl: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.maxSize = Math.max(1, options.maxSize ?? 1000);
    this.defaultTtl = options.ttlMs ?? Infinity;
    this.now = options.now ?? Date.now;
  }

  /** Number of live (non-expired) entries. Expired entries are purged on access. */
  get size(): number {
    this.purgeExpired();
    return this.map.size;
  }

  /** Get a value, or `undefined` if missing or expired. Refreshes LRU recency on hit. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    // Bump to most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Whether a live (non-expired) entry exists. Does not change recency. */
  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Store a value, optionally overriding the default TTL for this entry. Evicts LRU if over capacity. */
  set(key: K, value: V, ttlMs?: number): this {
    const ttl = ttlMs ?? this.defaultTtl;
    const expiresAt = ttl === Infinity ? Infinity : this.now() + ttl;
    // Re-insert so the key becomes most-recently-used.
    this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    this.evictIfNeeded();
    return this;
  }

  /** Delete one entry. Returns whether it existed. */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Memoize an async function: returns a wrapper that caches resolved values keyed
   * by `keyFn(...args)`. Note this caches the *resolved value*, not the in-flight
   * promise — use {@link SingleFlight} as well if you also need to dedupe concurrent
   * calls.
   *
   * @param keyFn - derives the cache key from the call arguments.
   * @param fn - the async function to memoize (its resolved value type must be `V`).
   * @param ttlMs - optional per-wrapper TTL override.
   */
  wrap<A extends unknown[]>(keyFn: (...args: A) => K, fn: (...args: A) => Promise<V>, ttlMs?: number): (...args: A) => Promise<V> {
    return async (...args: A): Promise<V> => {
      const key = keyFn(...args);
      const cached = this.map.get(key);
      if (cached && !this.isExpired(cached)) {
        // refresh recency
        this.map.delete(key);
        this.map.set(key, cached);
        return cached.value;
      }
      const value = await fn(...args);
      this.set(key, value, ttlMs);
      return value;
    };
  }

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt !== Infinity && this.now() >= entry.expiresAt;
  }

  private purgeExpired(): void {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) this.map.delete(key);
    }
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
