/**
 * Pure scoring for the eval harness.
 *
 * Given a case's expected outcome and what a replay observed, {@link scoreCase} decides pass/fail
 * and computes the per-case cost and output similarity. {@link aggregateScore} blends the four
 * suite-level metrics (pass-rate, cost-per-task, intervention-rate, output-similarity) into a single
 * 0..1 score using the configured, normalized weights. Everything here is a pure function of its
 * inputs so it is trivially unit-testable and deterministic.
 */
import type { EvalObservation } from '../eval/suite.js';
import type { EvalCase, EvalCaseResult, EvalSuiteScore } from './ports.js';

const has = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round = (n: number, p = 6): number => Math.round(n * 10 ** p) / 10 ** p;

/** Tokenize into a lowercase word set for overlap-based similarity. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 0),
  );
}

/**
 * Jaccard token-overlap similarity (0..1). Two empty strings are perfectly similar (1); one empty
 * and one non-empty are maximally dissimilar (0).
 */
export function textSimilarity(a: string, b: string): number {
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : round(inter / union, 4);
}

/** Score one observation against a case's expected outcome (pure). */
export function scoreCase(c: EvalCase, obs: EvalObservation): EvalCaseResult {
  const reasons: string[] = [];
  const conditions: boolean[] = [];
  const intervened = Boolean(obs.error);
  if (obs.error) reasons.push(`run error: ${obs.error}`);

  for (const tool of c.expected.tools ?? []) {
    const ok = obs.toolNames.includes(tool);
    conditions.push(ok);
    if (!ok) reasons.push(`tool "${tool}" was not called (called: ${obs.toolNames.join(', ') || 'none'})`);
  }
  for (const sub of c.expected.contains ?? []) {
    const ok = has(obs.output, sub);
    conditions.push(ok);
    if (!ok) reasons.push(`missing expected text "${sub}"`);
  }
  if (c.expected.maxCost !== undefined) {
    const ok = obs.cost <= c.expected.maxCost;
    conditions.push(ok);
    if (!ok) reasons.push(`cost $${obs.cost} exceeded budget $${c.expected.maxCost}`);
  }

  // A case with no declared conditions passes iff the run did not error (a smoke test).
  const pass = !obs.error && conditions.every(Boolean);
  const similarity = c.expected.output !== undefined ? textSimilarity(obs.output, c.expected.output) : 1;

  return {
    id: c.id,
    name: c.name,
    pass,
    cost: round(obs.cost),
    similarity,
    intervened,
    reasons: pass ? ['ok'] : reasons,
  };
}

/** The four metric weights (unnormalized). */
export interface ScoreWeights {
  passRate: number;
  cost: number;
  intervention: number;
  similarity: number;
}

/**
 * Blend the per-case results into aggregate metrics and a single 0..1 score. Cost is normalized
 * against `costCeiling` (cost at/above the ceiling scores 0; free scores 1); intervention is
 * inverted (fewer interventions is better). Weights are normalized so the blend is always 0..1.
 */
export function aggregateScore(
  suiteId: string,
  agent: string,
  results: EvalCaseResult[],
  weights: ScoreWeights,
  costCeiling: number,
): EvalSuiteScore {
  const n = results.length;
  const passRate = n ? results.filter((r) => r.pass).length / n : 0;
  const costPerTask = n ? results.reduce((s, r) => s + r.cost, 0) / n : 0;
  const interventionRate = n ? results.filter((r) => r.intervened).length / n : 0;
  const similarity = n ? results.reduce((s, r) => s + r.similarity, 0) / n : 0;

  const costScore = clamp01(1 - costPerTask / (costCeiling > 0 ? costCeiling : 1));
  const interventionScore = clamp01(1 - interventionRate);

  const w = weights;
  const wsum = w.passRate + w.cost + w.intervention + w.similarity;
  const score =
    wsum > 0
      ? (w.passRate * passRate + w.cost * costScore + w.intervention * interventionScore + w.similarity * similarity) / wsum
      : 0;

  return {
    suiteId,
    agent,
    cases: n,
    passRate: round(passRate, 4),
    costPerTask: round(costPerTask),
    interventionRate: round(interventionRate, 4),
    similarity: round(similarity, 4),
    score: round(clamp01(score), 4),
    results,
  };
}
