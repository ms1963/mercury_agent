/**
 * Chaos fault injection — deliberately makes eligible tool calls fail or time out so the
 * agent's recovery paths (retries, circuit breakers, fallbacks, sagas) are actually exercised
 * instead of assumed. OFF by default and gated behind `reliability.chaos.enabled`; in product
 * code it only ever injects when an operator explicitly turns it on.
 *
 * Determinism: when a `seed` is configured the controller uses a small seeded PRNG so a chaos
 * run is reproducible (same tools fail in the same order); otherwise it falls back to
 * Math.random. No mocks — this injects into the real tool-execution path.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { EventBus } from '../events/bus.js';

export type ChaosInjection = 'fail' | 'timeout' | null;

/** Mulberry32 — tiny, fast, deterministic 32-bit PRNG for reproducible chaos. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Glob match supporting a trailing/embedded '*' (same minimal semantics used elsewhere). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

export interface ChaosStatus {
  enabled: boolean;
  failureProbability: number;
  timeoutProbability: number;
  latencyMs: number;
  tools: string[];
  injections: number;
}

export class ChaosController {
  private rng: () => number;
  private count = 0;

  constructor(private config: MercuryConfig, private bus?: EventBus) {
    const seed = config.reliability.chaos.seed;
    this.rng = seed === undefined ? Math.random : mulberry32(seed);
  }

  get enabled(): boolean {
    return this.config.reliability.chaos.enabled;
  }

  /** How many injections this controller has performed since construction. */
  get injections(): number {
    return this.count;
  }

  private eligible(toolName: string): boolean {
    const tools = this.config.reliability.chaos.tools;
    return tools.length === 0 || tools.some((g) => globMatch(g, toolName));
  }

  /**
   * Decide what (if anything) to inject for a tool call. Returns 'fail', 'timeout' or null.
   * Failure takes precedence over timeout when both roll true. Pure except for the injection
   * counter and an emitted event — the caller performs the actual failure/delay.
   */
  decide(toolName: string): ChaosInjection {
    if (!this.enabled || !this.eligible(toolName)) return null;
    const c = this.config.reliability.chaos;
    let injection: ChaosInjection = null;
    if (c.failureProbability > 0 && this.rng() < c.failureProbability) injection = 'fail';
    else if (c.timeoutProbability > 0 && this.rng() < c.timeoutProbability) injection = 'timeout';
    if (injection) {
      this.count++;
      this.bus?.emit({ type: 'chaos.injected', data: { tool: toolName, injection, latencyMs: injection === 'timeout' ? c.latencyMs : 0 } });
    }
    return injection;
  }

  get latencyMs(): number {
    return this.config.reliability.chaos.latencyMs;
  }

  status(): ChaosStatus {
    const c = this.config.reliability.chaos;
    return { enabled: c.enabled, failureProbability: c.failureProbability, timeoutProbability: c.timeoutProbability, latencyMs: c.latencyMs, tools: c.tools, injections: this.count };
  }
}
