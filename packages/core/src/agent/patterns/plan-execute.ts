/**
 * Plan-and-Execute: the model first writes a short JSON plan, each step is executed
 * with the tool loop (seeing results of earlier steps), then a final synthesis answers
 * the user. Good for multi-step tasks with a clear decomposition.
 */
import { extractJson } from '../../types/common.js';
import type { ChatMessage } from '../../types/messages.js';
import { finalAnswer, type Pattern } from './types.js';

export const planExecutePattern: Pattern = {
  name: 'plan-execute',
  description: 'Plan-and-Execute: write a plan of steps first, then execute each step with tools; best for multi-step tasks',
  async run(ctx) {
    const planRaw = await ctx.complete(
      [
        { role: 'system', content: 'You are a planner. Break the goal into 1-6 concrete, ordered steps. Reply ONLY with JSON: {"steps": ["..."]}' },
        { role: 'user', content: `GOAL: ${ctx.task}` },
      ],
      { json: true },
    );
    const steps = (extractJson<{ steps?: string[] }>(planRaw)?.steps ?? [ctx.task]).filter((s) => typeof s === 'string' && s.trim()).slice(0, 6);
    ctx.emit('plan', { steps });

    const results: string[] = [];
    let toolCalls = 0;
    const base = ctx.messages.slice(0, -1);
    for (const [i, step] of steps.entries()) {
      const msgs: ChatMessage[] = [
        ...base,
        { role: 'user', content: `Overall goal: ${ctx.task}\n\nResults so far:\n${results.map((r, j) => `${j + 1}. ${r}`).join('\n') || '(none)'}\n\nNow do step ${i + 1}/${steps.length}: ${step}\nReply with the result of this step only.` },
      ];
      const r = await ctx.loop(msgs, { stream: false, maxIterations: 6 });
      toolCalls += r.toolCalls;
      results.push(`${step} → ${r.output.slice(0, 1500)}`);
      ctx.emit('plan.step', { index: i, step, result: r.output.slice(0, 500) });
    }
    if (steps.length === 1) return finalAnswer(results[0]!.split(' → ').slice(1).join(' → '), toolCalls, { steps });
    const output = await ctx.complete(
      [...base, { role: 'user', content: `Goal: ${ctx.task}\n\nStep results:\n${results.map((r, j) => `${j + 1}. ${r}`).join('\n')}\n\nWrite the final answer for the user.` }],
      { stream: true },
    );
    return finalAnswer(output, toolCalls, { steps });
  },
};
