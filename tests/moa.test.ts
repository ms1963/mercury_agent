/**
 * Offline, deterministic tests for the Mixture-of-Agents engine (Tier-3 gap #10).
 *
 * SCOPE: fully offline and deterministic. Every proposer/aggregator model call goes through an INJECTED
 * {@link MoaModelCall} stub — no real network, no router, no provider, no DB. The stub records the
 * requests it sees and returns canned answers (or throws) per slot, so proposer fan-out, synthesize
 * aggregation, vote selection and the error/edge paths are all exercised deterministically.
 *
 * NOTE: these verify the MoA *wiring* (fan-out, aggregation, voting, validation, graceful degradation).
 * They do NOT exercise real models — the live model-call runner (`m.moaModelCall`) is wired to the LLM
 * gateway in the runtime and is not part of these offline tests.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAggregatorMessages,
  buildProposerMessages,
  normalizeAnswer,
  runMoa,
  runProposers,
  tallyVotes,
  validateMoaOptions,
  MOA_AGGREGATOR_SYSTEM,
  type MoaModelCall,
  type MoaModelRequest,
  type MoaProposal,
} from '@mercury/core';

/**
 * A deterministic model-call stub. `answers` maps a slot id to a fixed answer (or an Error to throw).
 * The aggregator slot can be given a function to compute its answer from the user message it receives.
 * Every request is recorded in `seen` for assertions.
 */
function stubRunner(
  answers: Record<string, string | Error | ((req: MoaModelRequest) => string)>,
): MoaModelCall & { seen: MoaModelRequest[] } {
  const seen: MoaModelRequest[] = [];
  const fn = (async (req: MoaModelRequest): Promise<string> => {
    seen.push(req);
    const a = answers[req.slot];
    if (a === undefined) throw new Error(`no stub for slot ${req.slot}`);
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(req) : a;
  }) as MoaModelCall & { seen: MoaModelRequest[] };
  fn.seen = seen;
  return fn;
}

describe('moa — pure prompt building', () => {
  it('builds proposer messages with an optional system prompt', () => {
    expect(buildProposerMessages('hi')).toEqual([{ role: 'user', content: 'hi' }]);
    expect(buildProposerMessages('hi', 'be terse')).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    // Blank/whitespace system is ignored.
    expect(buildProposerMessages('hi', '   ')).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('builds aggregator messages that list only successful proposals and use the default system', () => {
    const proposals: MoaProposal[] = [
      { slot: 'a/1', index: 0, answer: 'Answer A', status: 'ok' },
      { slot: 'b/2', index: 1, answer: '', status: 'error', error: 'boom' },
      { slot: 'c/3', index: 2, answer: '  Answer C  ', status: 'ok' },
    ];
    const msgs = buildAggregatorMessages('What is 2+2?', proposals);
    expect(msgs[0]).toEqual({ role: 'system', content: MOA_AGGREGATOR_SYSTEM });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('What is 2+2?');
    expect(msgs[1].content).toContain('Proposal 1 (from a/1)');
    expect(msgs[1].content).toContain('Answer A');
    expect(msgs[1].content).toContain('Proposal 2 (from c/3)'); // c is renumbered to 2 (error excluded)
    expect(msgs[1].content).toContain('Answer C');
    expect(msgs[1].content).not.toContain('boom'); // failed proposal excluded
  });

  it('honors a custom aggregator system prompt', () => {
    const msgs = buildAggregatorMessages('q', [{ slot: 'a', index: 0, answer: 'x', status: 'ok' }], {
      system: 'CUSTOM',
    });
    expect(msgs[0]).toEqual({ role: 'system', content: 'CUSTOM' });
  });
});

describe('moa — voting primitives', () => {
  it('normalizes answers for equivalence', () => {
    expect(normalizeAnswer('  Hello   World  ')).toBe('hello world');
    expect(normalizeAnswer('HELLO WORLD')).toBe('hello world');
  });

  it('tallies votes, ignoring failures/empties, sorted by count then first appearance', () => {
    const proposals: MoaProposal[] = [
      { slot: 'a', index: 0, answer: 'Paris', status: 'ok' },
      { slot: 'b', index: 1, answer: 'paris', status: 'ok' }, // equivalent to Paris
      { slot: 'c', index: 2, answer: 'London', status: 'ok' },
      { slot: 'd', index: 3, answer: '', status: 'error', error: 'x' }, // ignored
      { slot: 'e', index: 4, answer: '   ', status: 'ok' }, // blank → ignored
    ];
    const votes = tallyVotes(proposals);
    expect(votes).toEqual([
      { answer: 'Paris', count: 2, voters: ['a#0', 'b#1'] },
      { answer: 'London', count: 1, voters: ['c#2'] },
    ]);
  });

  it('breaks ties by first appearance (stable)', () => {
    const proposals: MoaProposal[] = [
      { slot: 'a', index: 0, answer: 'Yes', status: 'ok' },
      { slot: 'b', index: 1, answer: 'No', status: 'ok' },
    ];
    expect(tallyVotes(proposals)[0].answer).toBe('Yes');
  });
});

describe('moa — validation', () => {
  const base = { prompt: 'q', proposers: ['a'], strategy: 'vote' as const };
  it('rejects a blank prompt', () => {
    expect(() => validateMoaOptions({ ...base, prompt: '  ' })).toThrow(/prompt is required/i);
  });
  it('rejects no proposers', () => {
    expect(() => validateMoaOptions({ ...base, proposers: [] })).toThrow(/at least one proposer/i);
  });
  it('rejects an unknown strategy', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateMoaOptions({ ...base, strategy: 'bogus' as any })).toThrow(/unknown moa strategy/i);
  });
  it('rejects synthesize without an aggregator', () => {
    expect(() => validateMoaOptions({ ...base, strategy: 'synthesize' })).toThrow(/requires an aggregator/i);
  });
  it('accepts a valid synthesize config', () => {
    expect(() => validateMoaOptions({ ...base, strategy: 'synthesize', aggregator: 'agg' })).not.toThrow();
  });
});

describe('moa — proposer fan-out', () => {
  it('runs every proposer in parallel and preserves order, capturing failures', async () => {
    const runner = stubRunner({ 'a/1': 'answer a', 'b/2': new Error('b down'), 'c/3': 'answer c' });
    const proposals = await runProposers(['a/1', 'b/2', 'c/3'], 'the prompt', runner, { system: 'sys' });
    expect(proposals).toEqual([
      { slot: 'a/1', index: 0, answer: 'answer a', status: 'ok' },
      { slot: 'b/2', index: 1, answer: '', status: 'error', error: 'b down' },
      { slot: 'c/3', index: 2, answer: 'answer c', status: 'ok' },
    ]);
    // The system prompt + user prompt reach every proposer.
    expect(runner.seen).toHaveLength(3);
    for (const req of runner.seen) {
      expect(req.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the prompt' },
      ]);
    }
  });

  it('distinguishes repeated slots by index (self-consistency sampling)', async () => {
    const runner = stubRunner({ 'a/1': 'x' });
    const proposals = await runProposers(['a/1', 'a/1'], 'p', runner);
    expect(proposals.map((p) => p.index)).toEqual([0, 1]);
    expect(proposals.every((p) => p.slot === 'a/1' && p.status === 'ok')).toBe(true);
  });
});

describe('moa — runMoa synthesize', () => {
  it('synthesizes a final answer from all proposals via the aggregator slot', async () => {
    const runner = stubRunner({
      'p/1': 'The capital is Paris.',
      'p/2': 'Paris is the capital of France.',
      'agg/x': (req) => `SYNTH:${req.messages[1].content.includes('Paris') ? 'ok' : 'miss'}`,
    });
    const res = await runMoa(
      { prompt: 'Capital of France?', proposers: ['p/1', 'p/2'], strategy: 'synthesize', aggregator: 'agg/x' },
      runner,
    );
    expect(res.strategy).toBe('synthesize');
    expect(res.aggregator).toBe('agg/x');
    expect(res.answer).toBe('SYNTH:ok');
    expect(res.usedProposers).toBe(2);
    expect(res.failedProposers).toBe(0);
    expect(res.proposals).toHaveLength(2);
    // 2 proposer calls + 1 aggregator call.
    expect(runner.seen).toHaveLength(3);
    expect(runner.seen[2].slot).toBe('agg/x');
  });

  it('synthesizes from survivors when some proposers fail', async () => {
    const runner = stubRunner({
      'p/1': 'good answer',
      'p/2': new Error('timeout'),
      'agg/x': 'final',
    });
    const res = await runMoa(
      { prompt: 'q', proposers: ['p/1', 'p/2'], strategy: 'synthesize', aggregator: 'agg/x' },
      runner,
    );
    expect(res.answer).toBe('final');
    expect(res.usedProposers).toBe(1);
    expect(res.failedProposers).toBe(1);
    // The aggregator user message must not contain the failed proposer's output.
    const aggReq = runner.seen.find((r) => r.slot === 'agg/x')!;
    expect(aggReq.messages[1].content).toContain('good answer');
    expect(aggReq.messages[1].content).not.toContain('timeout');
  });
});

describe('moa — runMoa vote', () => {
  it('selects the majority answer and does not call an aggregator', async () => {
    const runner = stubRunner({ a: 'Yes', b: 'yes', c: 'No' });
    const res = await runMoa({ prompt: 'q', proposers: ['a', 'b', 'c'], strategy: 'vote' }, runner);
    expect(res.strategy).toBe('vote');
    expect(res.answer).toBe('Yes'); // 2 of 3 (case-insensitive)
    expect(res.votes).toEqual([
      { answer: 'Yes', count: 2, voters: ['a#0', 'b#1'] },
      { answer: 'No', count: 1, voters: ['c#2'] },
    ]);
    expect(res.usedProposers).toBe(3);
    // Exactly 3 proposer calls — no aggregator call.
    expect(runner.seen).toHaveLength(3);
    expect(runner.seen.every((r) => r.slot !== 'agg')).toBe(true);
  });

  it('votes among survivors when a proposer fails', async () => {
    const runner = stubRunner({ a: 'Yes', b: new Error('x'), c: 'Yes' });
    const res = await runMoa({ prompt: 'q', proposers: ['a', 'b', 'c'], strategy: 'vote' }, runner);
    expect(res.answer).toBe('Yes');
    expect(res.usedProposers).toBe(2);
    expect(res.failedProposers).toBe(1);
  });
});

describe('moa — error/edge cases', () => {
  it('throws when no proposers are given', async () => {
    await expect(runMoa({ prompt: 'q', proposers: [], strategy: 'vote' }, stubRunner({}))).rejects.toThrow(
      /at least one proposer/i,
    );
  });

  it('throws when the prompt is blank', async () => {
    await expect(runMoa({ prompt: '   ', proposers: ['a'], strategy: 'vote' }, stubRunner({ a: 'x' }))).rejects.toThrow(
      /prompt is required/i,
    );
  });

  it('throws when synthesize has no aggregator', async () => {
    await expect(
      runMoa({ prompt: 'q', proposers: ['a'], strategy: 'synthesize' }, stubRunner({ a: 'x' })),
    ).rejects.toThrow(/requires an aggregator/i);
  });

  it('throws when every proposer fails (nothing to aggregate)', async () => {
    const runner = stubRunner({ a: new Error('down-a'), b: new Error('down-b') });
    await expect(runMoa({ prompt: 'q', proposers: ['a', 'b'], strategy: 'vote' }, runner)).rejects.toThrow(
      /all proposers failed/i,
    );
  });

  it('treats an all-empty-answer run as a failure', async () => {
    const runner = stubRunner({ a: '   ', b: '' });
    await expect(runMoa({ prompt: 'q', proposers: ['a', 'b'], strategy: 'vote' }, runner)).rejects.toThrow(
      /all proposers failed/i,
    );
  });

  it('does not call the aggregator when all proposers fail (fails before aggregation)', async () => {
    const runner = stubRunner({ a: new Error('x'), agg: 'should-not-run' });
    await expect(
      runMoa({ prompt: 'q', proposers: ['a'], strategy: 'synthesize', aggregator: 'agg' }, runner),
    ).rejects.toThrow(/all proposers failed/i);
    expect(runner.seen.some((r) => r.slot === 'agg')).toBe(false);
  });
});
