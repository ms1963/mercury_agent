/**
 * Retry helper — a thin, reusable wrapper that composes the existing
 * {@link backoffDelay} math (exponential backoff + jitter) into a generic
 * "retry this async function" utility.
 *
 * This deliberately does NOT reimplement backoff: the delay schedule is produced by
 * {@link backoffDelay} from `../llm/backoff.js`, which is the single source of truth
 * for retry timing across Mercury. The LLM service has its own inline retry loop
 * (also built on `backoffDelay`); this helper is for everything else that wants the
 * same behaviour without duplicating the loop.
 */
import { sleep } from '../types/common.js';
import { backoffDelay } from '../llm/backoff.js';

// Re-export so callers can `import { backoffDelay } from '@mercury/core'` reliability surface.
export { backoffDelay } from '../llm/backoff.js';

/** Options for {@link retry}. */
export interface RetryOptions {
  /** Maximum number of retries after the first attempt. Default 2 (i.e. up to 3 tries). */
  retries?: number;
  /** Base backoff delay (ms); the first retry waits ~`baseMs`. Default 500. */
  baseMs?: number;
  /** Jitter fraction (0..1) added on top of each backoff delay. Default 0.5. */
  jitter?: number;
  /**
   * Predicate deciding whether an error is worth retrying. Return `false` to fail
   * fast (e.g. for 4xx/validation errors). Default: retry every error.
   */
  isRetryable?: (err: unknown) => boolean;
  /** Abort signal; when aborted, no further retries happen and the sleep is interrupted. */
  signal?: AbortSignal;
  /** Injectable RNG forwarded to {@link backoffDelay} for deterministic tests. */
  rng?: () => number;
  /** Observability hook called before each backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying on failure with exponential backoff + jitter.
 *
 * @returns the first successful result of `fn`.
 * @throws the last error once retries are exhausted, the error is non-retryable, or
 *   the signal is aborted.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseMs = 500, jitter = 0.5, isRetryable = () => true, signal, rng, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err) || signal?.aborted) throw err;
      const delayMs = backoffDelay(attempt, baseMs, jitter, rng);
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}
