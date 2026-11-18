/**
 * Circuit breaker — a classic three-state breaker that fails fast while a
 * dependency is unhealthy, giving it room to recover instead of hammering it.
 *
 * States and transitions:
 *
 *   CLOSED      — calls flow through. Failures are counted in a rolling time
 *                 window; when the count reaches `failureThreshold` the breaker
 *                 trips to OPEN.
 *   OPEN        — calls are rejected immediately with a {@link CircuitOpenError}
 *                 (no downstream call is made). After `cooldownMs` the next call
 *                 is allowed through as a trial and the breaker moves to HALF_OPEN.
 *   HALF_OPEN   — a limited number of trial calls are allowed. Each success counts
 *                 toward `successThreshold`; once reached the breaker closes and
 *                 resets. Any failure sends it straight back to OPEN.
 *
 * The breaker is dependency-free: observability is delivered through the optional
 * {@link CircuitBreakerOptions.onStateChange} callback (wire it to an event bus at
 * the call site). The clock is injectable via `now()` so tests are deterministic.
 */
import { MercuryError } from '../types/common.js';

/** The three breaker states. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Error thrown by {@link CircuitBreaker.exec} when the circuit is OPEN. */
export class CircuitOpenError extends MercuryError {
  /** Logical domain for this error, per the reliability module convention. */
  readonly domain = 'reliability';
  constructor(
    /** Breaker name, if one was configured. */
    readonly circuit?: string,
    /** Estimated milliseconds until the breaker will allow a trial call again. */
    readonly retryAfterMs?: number,
  ) {
    super(`circuit${circuit ? ` '${circuit}'` : ''} is open`, 'circuit_open', 'reliability', 503);
    this.name = 'CircuitOpenError';
  }
}

/** A single state transition, delivered to {@link CircuitBreakerOptions.onStateChange}. */
export interface CircuitStateChange {
  circuit?: string;
  from: CircuitState;
  to: CircuitState;
  /** Clock value (from `now()`) at which the transition happened. */
  at: number;
  metrics: CircuitMetrics;
}

/** Point-in-time counters exposed by {@link CircuitBreaker.metrics}. */
export interface CircuitMetrics {
  state: CircuitState;
  /** Failures currently inside the rolling window (CLOSED accounting). */
  windowFailures: number;
  /** Consecutive successes recorded while HALF_OPEN. */
  halfOpenSuccesses: number;
  /** Total calls ever submitted to {@link CircuitBreaker.exec}. */
  totalCalls: number;
  /** Total downstream successes. */
  totalSuccesses: number;
  /** Total downstream failures (as classified by `isFailure`). */
  totalFailures: number;
  /** Total calls rejected without a downstream attempt (OPEN / half-open saturation). */
  totalShortCircuited: number;
  /** Number of times the breaker has transitioned to OPEN. */
  openedCount: number;
  /** Clock value of the most recent transition to OPEN, if any. */
  lastOpenedAt?: number;
}

/** Construction options. All are optional and have safe defaults. */
export interface CircuitBreakerOptions {
  /** Failures within the rolling window required to trip the breaker. Default 5. */
  failureThreshold?: number;
  /** Successes required while HALF_OPEN to close the breaker. Default 1. */
  successThreshold?: number;
  /** Time the breaker stays OPEN before allowing a trial call, in ms. Default 30000. */
  cooldownMs?: number;
  /**
   * Alias for {@link CircuitBreakerOptions.cooldownMs}. If both are given,
   * `cooldownMs` wins. Provided because both names are common in the wild.
   */
  resetTimeoutMs?: number;
  /** Rolling window (ms) over which failures are counted while CLOSED. Default 60000. */
  windowMs?: number;
  /** Max concurrent trial calls allowed while HALF_OPEN. Default = successThreshold. */
  halfOpenMaxConcurrent?: number;
  /**
   * Predicate deciding whether a thrown error counts as a failure. Return `false`
   * for errors that should not trip the breaker (e.g. 4xx/validation errors), in
   * which case the call is treated as pass-through — it affects neither the failure
   * count nor the half-open success count. Default: every error counts.
   */
  isFailure?: (err: unknown) => boolean;
  /** Injectable monotonic-ish clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Optional name used in errors and state-change events. */
  name?: string;
  /** Called on every state transition — wire this to your event bus/logger. */
  onStateChange?: (change: CircuitStateChange) => void;
}

/**
 * A dependency-free circuit breaker. Create one per logical dependency
 * (provider, host, model profile…) and route calls through {@link exec}.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly isFailure: (err: unknown) => boolean;
  private readonly now: () => number;
  readonly name?: string;
  private readonly onStateChange?: (change: CircuitStateChange) => void;

  private _state: CircuitState = 'closed';
  /** Timestamps of recent failures, pruned to the rolling window. */
  private failureTimes: number[] = [];
  private halfOpenSuccessCount = 0;
  private halfOpenInFlight = 0;
  private openedAt?: number;

  // Lifetime counters.
  private totalCalls = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalShortCircuited = 0;
  private openedCount = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.successThreshold = Math.max(1, options.successThreshold ?? 1);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? options.resetTimeoutMs ?? 30_000);
    this.windowMs = Math.max(0, options.windowMs ?? 60_000);
    this.halfOpenMaxConcurrent = Math.max(1, options.halfOpenMaxConcurrent ?? this.successThreshold);
    this.isFailure = options.isFailure ?? (() => true);
    this.now = options.now ?? Date.now;
    this.name = options.name;
    this.onStateChange = options.onStateChange;
  }

  /** Current breaker state. */
  get state(): CircuitState {
    // Surface a pending OPEN→HALF_OPEN cooldown expiry to read-only callers too.
    if (this._state === 'open' && this.cooldownElapsed()) return 'half_open';
    return this._state;
  }

  /** Snapshot of the breaker's counters. */
  get metrics(): CircuitMetrics {
    this.pruneWindow();
    return {
      state: this.state,
      windowFailures: this.failureTimes.length,
      halfOpenSuccesses: this.halfOpenSuccessCount,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalShortCircuited: this.totalShortCircuited,
      openedCount: this.openedCount,
      lastOpenedAt: this.openedAt,
    };
  }

  /**
   * Run `fn` through the breaker.
   *
   * @throws {@link CircuitOpenError} immediately (without calling `fn`) when the
   *   breaker is OPEN or HALF_OPEN trial capacity is saturated.
   * @throws whatever `fn` rejects with, after recording the outcome.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();

    if (this._state === 'open') {
      this.totalShortCircuited++;
      throw new CircuitOpenError(this.name, this.cooldownRemaining());
    }

    let countedHalfOpen = false;
    if (this._state === 'half_open') {
      if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) {
        this.totalShortCircuited++;
        throw new CircuitOpenError(this.name, this.cooldownRemaining());
      }
      this.halfOpenInFlight++;
      countedHalfOpen = true;
    }

    this.totalCalls++;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure();
      throw err;
    } finally {
      if (countedHalfOpen) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  /** Force the breaker back to CLOSED and clear all transient counters. */
  reset(): void {
    this.failureTimes = [];
    this.halfOpenSuccessCount = 0;
    this.halfOpenInFlight = 0;
    this.openedAt = undefined;
    this.transition('closed');
  }

  // --- internals ---

  private onSuccess(): void {
    this.totalSuccesses++;
    if (this._state === 'half_open') {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.successThreshold) {
        this.failureTimes = [];
        this.halfOpenSuccessCount = 0;
        this.transition('closed');
      }
    }
  }

  private onFailure(): void {
    this.totalFailures++;
    if (this._state === 'half_open') {
      this.open();
      return;
    }
    // CLOSED: record in the rolling window and trip if over threshold.
    this.failureTimes.push(this.now());
    this.pruneWindow();
    if (this.failureTimes.length >= this.failureThreshold) this.open();
  }

  private open(): void {
    this.openedAt = this.now();
    this.openedCount++;
    this.halfOpenSuccessCount = 0;
    this.halfOpenInFlight = 0;
    this.transition('open');
  }

  /** If OPEN and the cooldown has elapsed, move to HALF_OPEN to allow a trial. */
  private maybeHalfOpen(): void {
    if (this._state === 'open' && this.cooldownElapsed()) {
      this.halfOpenSuccessCount = 0;
      this.halfOpenInFlight = 0;
      this.transition('half_open');
    }
  }

  private cooldownElapsed(): boolean {
    return this.openedAt !== undefined && this.now() - this.openedAt >= this.cooldownMs;
  }

  private cooldownRemaining(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
  }

  private pruneWindow(): void {
    if (this.windowMs <= 0) return;
    const cutoff = this.now() - this.windowMs;
    if (this.failureTimes.length && this.failureTimes[0]! < cutoff) {
      this.failureTimes = this.failureTimes.filter((t) => t >= cutoff);
    }
  }

  private transition(to: CircuitState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.onStateChange?.({ circuit: this.name, from, to, at: this.now(), metrics: this.metrics });
  }
}
