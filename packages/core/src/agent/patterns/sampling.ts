/**
 * Sampling-based patterns:
 *  - self-consistency: sample N independent answers (higher temperature) and pick the
 *    majority; ties are broken by the decision engine.
 *  - tot (Tree-of-Thoughts lite): propose a few distinct approaches, develop each,
 *    score them with the decision engine and return the best (breadth 3, depth 1).
 */
import { extractJson } from '../../types/common.js';
import { finalAnswer, type Pattern } from './types.js';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200);

export const selfConsistencyPattern: Pattern = {
  name: 'self-consistency',
  description: 'Self-consistency: sample several independent answers and take the majority; good for questions with one correct answer',
  async run(ctx) {
    const samples: string[] = [];
    let toolCalls = 0;
    for (let i = 0; i < 3; i++) {
      const r = await ctx.loop(ctx.messages, { stream: false, temperature: 0.8 });
      samples.push(r.output);
      toolCalls += r.toolCalls;
    }
    const counts = new Map<string, { n: number; text: string }>();
    for (const s of samples) {
      const k = norm(s);
      counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, text: s });
    }
    const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
    let output = ranked[0]!.text;
    if (ranked.length > 1 && ranked[0]!.n === ranked[1]!.n) {
      const criteria = Object.fromEntries(ranked.map((r, i) => [`answer_${i + 1}`, r.text.slice(0, 500)]));
      const pick = await ctx.judgment.engine.choice({ task: ctx.task }, 'Which candidate answer is most likely correct?', criteria, 'self_consistency', ctx.runId).catch(() => undefined);
      const idx = pick ? Number(pick.choice.replace('answer_', '')) - 1 : 0;
      output = ranked[idx]?.text ?? output;
    }
    ctx.emit('self_consistency', { samples: samples.length, distinct: ranked.length, votes: ranked[0]!.n });
    ctx.onDelta?.(output);
    return finalAnswer(output, toolCalls, { samples: samples.length, distinct: ranked.length });
  },
};

export const totPattern: Pattern = {
  name: 'tot',
  description: 'Tree-of-Thoughts (lite): explore several approaches in parallel and keep the best-scoring one; good for open-ended or creative problems',
  async run(ctx) {
    const raw = await ctx.complete(
      [
        { role: 'system', content: 'Propose 3 distinct approaches to solve the task. Reply ONLY with JSON: {"approaches": ["...", "...", "..."]}' },
        { role: 'user', content: ctx.task },
      ],
      { json: true },
    );
    const approaches = (extractJson<{ approaches?: string[] }>(raw)?.approaches ?? ['Direct answer']).slice(0, 3);
    let toolCalls = 0;
    const branches: Array<{ approach: string; output: string; score: number }> = [];
    for (const approach of approaches) {
      const r = await ctx.loop([...ctx.messages.slice(0, -1), { role: 'system', content: `Use this approach: ${approach}` }, ctx.messages[ctx.messages.length - 1]!], { stream: false, maxIterations: 5 });
      toolCalls += r.toolCalls;
      const s = await ctx.judgment.scoreAnswer(ctx.task, r.output, ctx.runId);
      branches.push({ approach, output: r.output, score: s?.fraction ?? 0.5 });
    }
    branches.sort((a, b) => b.score - a.score);
    ctx.emit('tot.branches', { branches: branches.map((b) => ({ approach: b.approach, score: b.score })) });
    ctx.onDelta?.(branches[0]!.output);
    return finalAnswer(branches[0]!.output, toolCalls, { approach: branches[0]!.approach, branches: branches.length });
  },
};
