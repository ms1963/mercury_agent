/**
 * Mixture-of-Agents (MoA) — aggregate/vote across several model slots (Tier-3 gap #10).
 *
 * MoA is a natural extension of the Jev router and the teams orchestrator: where a team delegates
 * *different* subtasks to *different* members, MoA sends the **same** prompt to several **proposer**
 * model slots in parallel, collects their proposals, and produces one final answer by either
 *   - `synthesize` — hand every proposal to an **aggregator** model slot that writes the final answer, or
 *   - `vote` — pick the proposal supported by the most proposers (majority / self-consistency).
 *
 * A "model slot" here is exactly the same `"<provider>/<model>"` id (or the router alias `"auto"`) the
 * rest of Mercury uses — the LLMService / ProviderRegistry resolve it. MoA does **not** invent a new
 * LLM-call path: every model call goes through an INJECTED {@link MoaModelCall} runner, which the
 * runtime wires to `LLMService.complete` (the same gateway teams' synthesizer uses). This keeps the
 * whole module pure and unit-testable offline with a stub runner — no network, no DB, no fs.
 *
 * The module is split into PURE functions (prompt building, voting, orchestration) plus the injected
 * runner. Exported types are prefixed `Moa*` to avoid barrel-export collisions.
 */
import { MercuryError } from '../types/common.js';

/** Aggregation strategy: synthesize a final answer with an aggregator model, or vote across proposals. */
export type MoaStrategy = 'synthesize' | 'vote';

/** Role subset accepted by the model-call runner (maps onto Mercury's ChatMessage roles). */
export type MoaRole = 'system' | 'user' | 'assistant';

/** One message handed to the runner. */
export interface MoaMessage {
  role: MoaRole;
  content: string;
}

/** A single model call: given a slot id and messages, return the assistant text. */
export interface MoaModelRequest {
  /** Model slot id ("<provider>/<model>" or "auto"). */
  slot: string;
  messages: MoaMessage[];
}

/**
 * The injected model-call runner. The runtime wires this to `LLMService.complete`; tests inject a
 * deterministic stub. It must resolve to the model's text answer, or reject on failure.
 */
export type MoaModelCall = (req: MoaModelRequest) => Promise<string>;

/** One proposer's result. `status` is `error` when the runner rejected (captured, never thrown). */
export interface MoaProposal {
  /** Model slot that produced this proposal. */
  slot: string;
  /** Position in the proposer list (stable ordering; distinguishes repeated slots). */
  index: number;
  /** The proposer's answer (empty string on error). */
  answer: string;
  status: 'ok' | 'error';
  error?: string;
}

/** A tallied group of equivalent answers for the `vote` strategy. */
export interface MoaVoteTally {
  /** The representative (verbatim) answer for this group — the first proposal seen in the group. */
  answer: string;
  /** How many proposers produced an equivalent answer. */
  count: number;
  /** Slots (with index) that voted for this group, in proposer order. */
  voters: string[];
}

/** Options for a single MoA query. */
export interface MoaOptions {
  /** The shared prompt sent to every proposer. */
  prompt: string;
  /** Proposer model slots (fanned out in parallel). At least one is required. */
  proposers: string[];
  /** Aggregation strategy. */
  strategy: MoaStrategy;
  /** Aggregator model slot (required for `synthesize`; ignored for `vote`). */
  aggregator?: string;
  /** Optional system prompt prepended to every proposer call. */
  system?: string;
  /** Optional system prompt for the aggregator (defaults to a built-in synthesis instruction). */
  aggregatorSystem?: string;
}

/** The result of an MoA query. */
export interface MoaResult {
  /** The final answer (synthesized or voted). */
  answer: string;
  strategy: MoaStrategy;
  /** Every proposer's result, including failures, in proposer order. */
  proposals: MoaProposal[];
  /** Aggregator slot used (synthesize only). */
  aggregator?: string;
  /** Vote tallies (vote only), highest count first. */
  votes?: MoaVoteTally[];
  /** Number of proposers that answered successfully. */
  usedProposers: number;
  /** Number of proposers that failed. */
  failedProposers: number;
}

/** Default system prompt handed to the aggregator when the caller does not provide one. */
export const MOA_AGGREGATOR_SYSTEM =
  'You are an aggregator. Several assistants independently answered the same task. ' +
  'Synthesize their proposals into a single, correct, coherent final answer. ' +
  'Prefer facts corroborated across proposals, reconcile disagreements on the merits, ' +
  'and do not merely concatenate them.';

// ───────────────────────────────── pure: prompt building ─────────────────────────────────

/** Build the messages for one proposer call (optional system + the shared user prompt). */
export function buildProposerMessages(prompt: string, system?: string): MoaMessage[] {
  const messages: MoaMessage[] = [];
  if (system && system.trim()) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

/**
 * Build the messages for the aggregator call: a synthesis system prompt plus a user message that
 * restates the task and lists every successful proposal, labeled by proposer. Only `ok` proposals are
 * included (failures are excluded so a dead model cannot pollute the synthesis).
 */
export function buildAggregatorMessages(
  prompt: string,
  proposals: MoaProposal[],
  opts: { system?: string } = {},
): MoaMessage[] {
  const good = proposals.filter((p) => p.status === 'ok' && p.answer.trim());
  const body = good
    .map((p, i) => `### Proposal ${i + 1} (from ${p.slot})\n${p.answer.trim()}`)
    .join('\n\n');
  return [
    { role: 'system', content: opts.system?.trim() || MOA_AGGREGATOR_SYSTEM },
    { role: 'user', content: `Task:\n${prompt}\n\nProposals:\n${body}\n\nWrite the single best final answer to the task.` },
  ];
}

// ───────────────────────────────── pure: voting ─────────────────────────────────

/** Normalize an answer for vote equivalence: trim, collapse whitespace, lowercase. */
export function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Tally equivalent answers across successful proposals. Groups by {@link normalizeAnswer}; the
 * representative `answer` is the first verbatim proposal in each group. Returns groups sorted by count
 * (desc); ties are broken by first appearance (stable), so the result is deterministic.
 */
export function tallyVotes(proposals: MoaProposal[]): MoaVoteTally[] {
  const groups = new Map<string, MoaVoteTally & { firstIndex: number }>();
  for (const p of proposals) {
    if (p.status !== 'ok' || !p.answer.trim()) continue;
    const key = normalizeAnswer(p.answer);
    const existing = groups.get(key);
    const voter = `${p.slot}#${p.index}`;
    if (existing) {
      existing.count += 1;
      existing.voters.push(voter);
    } else {
      groups.set(key, { answer: p.answer.trim(), count: 1, voters: [voter], firstIndex: p.index });
    }
  }
  return [...groups.values()]
    .sort((a, b) => (b.count - a.count) || (a.firstIndex - b.firstIndex))
    .map(({ answer, count, voters }) => ({ answer, count, voters }));
}

// ───────────────────────────────── orchestration ─────────────────────────────────

/**
 * Fan the prompt out to every proposer in parallel through the injected runner. A proposer that
 * rejects is captured as a `status: 'error'` proposal (never throws), mirroring the teams graceful
 * degradation pattern. Ordering follows the `proposers` array.
 */
export async function runProposers(
  proposers: string[],
  prompt: string,
  runner: MoaModelCall,
  opts: { system?: string } = {},
): Promise<MoaProposal[]> {
  const messages = buildProposerMessages(prompt, opts.system);
  return Promise.all(
    proposers.map(async (slot, index): Promise<MoaProposal> => {
      try {
        const answer = await runner({ slot, messages });
        return { slot, index, answer: answer ?? '', status: 'ok' };
      } catch (err) {
        return { slot, index, answer: '', status: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** Validate MoA options, throwing a well-typed {@link MercuryError} on misuse. */
export function validateMoaOptions(opts: MoaOptions): void {
  if (!opts.prompt?.trim()) {
    throw new MercuryError('A prompt is required for an MoA query', 'invalid_moa', 'moa', 400);
  }
  if (!opts.proposers?.length) {
    throw new MercuryError('At least one proposer model slot is required', 'invalid_moa', 'moa', 400);
  }
  if (opts.strategy !== 'synthesize' && opts.strategy !== 'vote') {
    throw new MercuryError(`Unknown MoA strategy "${opts.strategy}" (use: synthesize, vote)`, 'invalid_moa', 'moa', 400);
  }
  if (opts.strategy === 'synthesize' && !opts.aggregator?.trim()) {
    throw new MercuryError('The synthesize strategy requires an aggregator model slot', 'invalid_moa', 'moa', 400);
  }
}

/**
 * Run a full Mixture-of-Agents query:
 *   1. fan the prompt out to every proposer in parallel (via the injected runner),
 *   2. collect proposals (failures captured, not thrown),
 *   3. aggregate — `synthesize` calls the aggregator slot on all successful proposals; `vote` selects
 *      the answer with the most proposer support (ties broken by first appearance).
 *
 * Throws a {@link MercuryError} when the options are invalid or when **no** proposer succeeded (there
 * is nothing to aggregate). Fully deterministic given a deterministic runner.
 */
export async function runMoa(opts: MoaOptions, runner: MoaModelCall): Promise<MoaResult> {
  validateMoaOptions(opts);
  const proposals = await runProposers(opts.proposers, opts.prompt, runner, { system: opts.system });
  const good = proposals.filter((p) => p.status === 'ok' && p.answer.trim());
  const usedProposers = good.length;
  const failedProposers = proposals.length - usedProposers;

  if (usedProposers === 0) {
    const detail = proposals.map((p) => `${p.slot}: ${p.error ?? 'empty answer'}`).join('; ');
    throw new MercuryError(`All proposers failed or returned empty answers. ${detail}`, 'moa_failed', 'moa', 502);
  }

  if (opts.strategy === 'vote') {
    const votes = tallyVotes(proposals);
    return {
      answer: votes[0]?.answer ?? '',
      strategy: 'vote',
      proposals,
      votes,
      usedProposers,
      failedProposers,
    };
  }

  // synthesize
  const aggregator = opts.aggregator!;
  const messages = buildAggregatorMessages(opts.prompt, proposals, { system: opts.aggregatorSystem });
  const answer = await runner({ slot: aggregator, messages });
  return {
    answer: answer ?? '',
    strategy: 'synthesize',
    proposals,
    aggregator,
    usedProposers,
    failedProposers,
  };
}
