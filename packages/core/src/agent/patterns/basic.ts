/**
 * The simplest patterns:
 *  - react: plain tool loop (Thought → Action → Observation ... → Answer).
 *  - cot:   chain-of-thought — asks the model to reason step by step before answering
 *           (tools still available).
 */
import type { ChatMessage } from '../../types/messages.js';
import type { Pattern } from './types.js';

export const reactPattern: Pattern = {
  name: 'react',
  description: 'ReAct: interleave reasoning with tool calls; best default for tasks needing tools or lookups',
  async run(ctx) {
    const r = await ctx.loop(ctx.messages);
    return { output: r.output, newMessages: r.newMessages, toolCalls: r.toolCalls, meta: { iterations: r.iterations, exhausted: r.exhausted } };
  },
};

export const cotPattern: Pattern = {
  name: 'cot',
  description: 'Chain-of-thought: reason step by step before answering; good for math, logic and explanations',
  async run(ctx) {
    const nudge: ChatMessage = { role: 'system', content: 'Reason step by step internally. Then give the final answer, starting with "Answer:" on its own line, followed by a short justification.' };
    const r = await ctx.loop([...ctx.messages.slice(0, -1), nudge, ctx.messages[ctx.messages.length - 1]!]);
    return { output: r.output, newMessages: r.newMessages, toolCalls: r.toolCalls };
  },
};
