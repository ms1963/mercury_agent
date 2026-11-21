/**
 * Governed auto-tune.
 *
 * The tuner proposes small, reversible changes to how the agent runs — model routing, agent
 * pattern, sampling temperature, or promoting/retiring a distilled skill — and tests each one
 * against a scored eval suite. A proposal is kept ONLY when it improves the suite score by at least
 * the configured threshold AND does not break governance or the per-task budget; everything else is
 * rejected with a recorded reason. The tuner never applies anything itself: it returns scored
 * {@link TuneEvaluation}s and the owning {@link EvalService} decides (governed by config) whether to
 * persist an accepted change.
 *
 * `measureProposal` is injected by the service: it applies the proposal's run-overrides (or toggles
 * the distilled skill) around one real suite replay and reverts afterwards, so the tuner stays a
 * pure decision function over observed scores — no mocks, deterministic given the measurements.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { DistilledSkill } from '../distill/ports.js';
import type { EvalSuiteScore, RunOverrides, TuneEvaluation, TuneProposal } from './ports.js';

/**
 * Config key prefixes that are governance-protected: a tune proposal may never weaken security or
 * governance controls, so any patch touching these keys is rejected outright (before it is even
 * measured). This is the "governance still enforced during tuning" guard.
 */
export const GOVERNANCE_PROTECTED_PREFIXES = ['security.', 'governance.', 'approvals.', 'policies.'];

/** True when a proposal's patch touches a governance-protected config key. */
export function violatesGovernance(proposal: TuneProposal): boolean {
  return Object.keys(proposal.patch).some((key) =>
    GOVERNANCE_PROTECTED_PREFIXES.some((p) => key === p.replace(/\.$/, '') || key.startsWith(p)),
  );
}

/** Map a config-patch proposal to the per-run overrides used to test it without mutating config. */
export function overridesFor(proposal: TuneProposal): RunOverrides {
  const o: RunOverrides = {};
  const p = proposal.patch;
  if (typeof p['agent.model'] === 'string') o.model = p['agent.model'] as string;
  if (typeof p['agent.pattern'] === 'string') o.pattern = p['agent.pattern'] as string;
  if (typeof p['agent.temperature'] === 'number') o.temperature = p['agent.temperature'] as number;
  return o;
}

/**
 * Build a default set of candidate proposals from the current config and the available distilled
 * skills. These are deliberately conservative, well-understood knobs; an operator (or a future
 * LLM-backed tuner) can supply their own proposals instead — the evaluation/acceptance logic is the
 * same either way.
 */
export function defaultProposals(config: MercuryConfig, skills: DistilledSkill[] = []): TuneProposal[] {
  const out: TuneProposal[] = [];
  const agent = config.agent ?? ({} as MercuryConfig['agent']);

  // Pattern: try the alternate reasoning pattern.
  const altPattern = agent.pattern === 'react' ? 'plan-execute' : 'react';
  out.push({
    kind: 'pattern',
    summary: `Switch agent pattern ${agent.pattern ?? 'react'} → ${altPattern}`,
    patch: { 'agent.pattern': altPattern },
  });

  // Temperature: nudge toward more deterministic output.
  const curTemp = typeof agent.temperature === 'number' ? agent.temperature : 0.7;
  const lowerTemp = Math.max(0, Math.round((curTemp - 0.3) * 100) / 100);
  if (lowerTemp !== curTemp) {
    out.push({
      kind: 'temperature',
      summary: `Lower sampling temperature ${curTemp} → ${lowerTemp}`,
      patch: { 'agent.temperature': lowerTemp },
    });
  }

  // Skill promotion: promote a pending distilled skill so the planner may reuse it.
  for (const s of skills.filter((x) => x.status === 'pending').slice(0, 2)) {
    out.push({
      kind: 'skill-promote',
      summary: `Promote distilled skill "${s.name}" to approved`,
      patch: {},
      skillId: s.id,
    });
  }
  // Skill retirement: retire an approved skill that is dragging outcomes down.
  for (const s of skills.filter((x) => x.status === 'approved' && x.stats.uses >= 3 && x.stats.successRate < 0.5).slice(0, 2)) {
    out.push({
      kind: 'skill-retire',
      summary: `Retire under-performing skill "${s.name}" (success ${Math.round(s.stats.successRate * 100)}%)`,
      patch: {},
      skillId: s.id,
    });
  }

  return out;
}

export interface EvaluateOptions {
  /** Minimum absolute score gain (0..1) required to accept a proposal. */
  minImprovement: number;
  /** Per-task cost ceiling ($); a candidate whose mean cost exceeds it is rejected (budget guard). */
  costCeiling: number;
}

/**
 * Evaluate a single proposal against a baseline: enforce governance + budget, measure the candidate
 * score, and decide acceptance. Pure given `measureProposal` (the only effectful dependency).
 */
export async function evaluateProposal(
  proposal: TuneProposal,
  baseline: EvalSuiteScore,
  measureProposal: (p: TuneProposal) => Promise<EvalSuiteScore>,
  opts: EvaluateOptions,
): Promise<TuneEvaluation> {
  // 1. Governance: never weaken security/governance controls.
  if (violatesGovernance(proposal)) {
    return {
      proposal,
      baselineScore: baseline.score,
      candidateScore: baseline.score,
      improvement: 0,
      accepted: false,
      rejectedReason: 'governance: proposal touches a protected security/governance key',
    };
  }

  // 2. Measure the candidate with a real suite replay.
  const candidate = await measureProposal(proposal);
  const improvement = Math.round((candidate.score - baseline.score) * 1e6) / 1e6;

  // 3. Budget: a candidate that blows the per-task cost ceiling is rejected regardless of score.
  if (opts.costCeiling > 0 && candidate.costPerTask > opts.costCeiling) {
    return {
      proposal,
      baselineScore: baseline.score,
      candidateScore: candidate.score,
      improvement,
      accepted: false,
      rejectedReason: `budget: cost/task $${candidate.costPerTask} exceeds ceiling $${opts.costCeiling}`,
    };
  }

  // 4. Accept only a real improvement above the threshold.
  const accepted = improvement >= opts.minImprovement;
  return {
    proposal,
    baselineScore: baseline.score,
    candidateScore: candidate.score,
    improvement,
    accepted,
    rejectedReason: accepted ? undefined : `no improvement: ${improvement} < required ${opts.minImprovement}`,
  };
}
