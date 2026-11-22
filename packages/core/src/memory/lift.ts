/**
 * Memory-lift evaluation: a minimal, dependency-free way to quantify how much governed memory +
 * knowledge grounding improve answers. Each case is run twice — once WITH the memory context that
 * {@link MemoryManager.buildContext} would inject, once WITHOUT — and scored by a pluggable scorer
 * (default: case-insensitive substring match against an expected answer). The reported `lift` is the
 * difference in mean score (with − without), so a positive number means memory helped.
 */
import type { MemoryManager } from './manager.js';

export interface MemoryLiftCase {
  userId: string;
  /** The user prompt / question. */
  query: string;
  /** Expected answer fragment (used by the default scorer). */
  expect?: string;
}

/** Runs the agent/LLM on a prompt and returns its answer. */
export type LiftRunner = (prompt: string, ctx: string) => Promise<string>;

/** Scores an answer in [0,1]. */
export type LiftScorer = (answer: string, c: MemoryLiftCase) => number;

const defaultScorer: LiftScorer = (answer, c) => (c.expect && answer.toLowerCase().includes(c.expect.toLowerCase()) ? 1 : 0);

export interface MemoryLiftResult {
  cases: number;
  withMemory: number;
  withoutMemory: number;
  /** withMemory − withoutMemory (mean score delta). */
  lift: number;
  details: Array<{ query: string; withMemory: number; withoutMemory: number }>;
}

export async function measureMemoryLift(
  memory: MemoryManager,
  runner: LiftRunner,
  cases: MemoryLiftCase[],
  opts: { sessionId?: string; scorer?: LiftScorer } = {},
): Promise<MemoryLiftResult> {
  const scorer = opts.scorer ?? defaultScorer;
  const sessionId = opts.sessionId ?? 'memory-lift';
  const details: MemoryLiftResult['details'] = [];
  let withSum = 0;
  let withoutSum = 0;
  for (const c of cases) {
    const ctx = await memory.buildContext(c.userId, sessionId, c.query).catch(() => '');
    const withAns = await runner(c.query, ctx).catch(() => '');
    const withoutAns = await runner(c.query, '').catch(() => '');
    const w = scorer(withAns, c);
    const wo = scorer(withoutAns, c);
    withSum += w;
    withoutSum += wo;
    details.push({ query: c.query, withMemory: w, withoutMemory: wo });
  }
  const n = Math.max(cases.length, 1);
  const withMemory = withSum / n;
  const withoutMemory = withoutSum / n;
  return { cases: cases.length, withMemory, withoutMemory, lift: withMemory - withoutMemory, details };
}
