/**
 * Gap detection for self-extending tools.
 *
 * A "tool-miss" is when a capability was requested but no registered tool matched it. One-off misses
 * must NOT trigger synthesis (the model fat-fingered a name, or the task was genuinely impossible), so
 * misses are tracked per capability signature and only cross the trigger line after a configurable
 * threshold of repeats.
 *
 * Pure + injectable: the tracker holds only an in-memory counter map and an injected clock. It never
 * spawns synthesis itself — it just answers "has this gap been seen enough to act on?".
 */
import type { SynthClock } from './types.js';

/** A single recorded miss. */
export interface GapMiss {
  /** Normalized capability signature (the thing that was missing). */
  key: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** The most recent triggering context (truncated) for provenance. */
  lastContext: string;
}

/**
 * Normalize a requested capability into a stable key, so "fetchWeather", "fetch_weather" and
 * "  Fetch Weather  " collapse to one gap. Lower-cased, non-alphanumerics → underscore, collapsed.
 */
export function gapKey(requested: string): string {
  return requested
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
}

const MAX_CONTEXT = 500;

/** Tracks repeated tool-misses and decides when a gap is worth synthesizing a tool for. */
export class GapTracker {
  private readonly misses = new Map<string, GapMiss>();

  constructor(private readonly clock: SynthClock = () => new Date().toISOString()) {}

  /**
   * Record one miss for a requested capability. Returns the updated {@link GapMiss}. `context` is the
   * triggering prompt/task text; it is truncated and kept for provenance when synthesis fires.
   */
  record(requested: string, context = ''): GapMiss {
    const key = gapKey(requested);
    const now = this.clock();
    const existing = this.misses.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      if (context) existing.lastContext = context.slice(0, MAX_CONTEXT);
      return existing;
    }
    const miss: GapMiss = { key, count: 1, firstSeen: now, lastSeen: now, lastContext: context.slice(0, MAX_CONTEXT) };
    this.misses.set(key, miss);
    return miss;
  }

  /** Current miss count for a capability (0 if never seen). */
  count(requested: string): number {
    return this.misses.get(gapKey(requested))?.count ?? 0;
  }

  /** The recorded miss for a capability, if any. */
  get(requested: string): GapMiss | undefined {
    return this.misses.get(gapKey(requested));
  }

  /**
   * True when this gap has been seen at least `threshold` times (threshold is clamped to >= 1 so a
   * misconfigured 0 never auto-fires on the first miss).
   */
  shouldTrigger(requested: string, threshold: number): boolean {
    return this.count(requested) >= Math.max(1, Math.floor(threshold));
  }

  /** Clear the counter for a capability (call after synthesis is attempted so it doesn't re-fire). */
  reset(requested: string): void {
    this.misses.delete(gapKey(requested));
  }

  /** Clear every counter. */
  clear(): void {
    this.misses.clear();
  }

  /** All tracked misses, most-missed first. */
  list(): GapMiss[] {
    return [...this.misses.values()].sort((a, b) => b.count - a.count);
  }
}
