/**
 * Self-correcting patterns:
 *  - reflexion: answer → judge (decision engine score) → if below threshold, verbal
 *    self-critique becomes a "lesson" for the next attempt (max 2 retries).
 *  - critic:    draft → independent critic review → revised answer.
 */
import type { ChatMessage } from '../../types/messages.js';
import { finalAnswer, type Pattern } from './types.js';

export const reflexionPattern: Pattern = {
  name: 'reflexion',
  description: 'Reflexion: attempt, self-evaluate, learn from mistakes and retry; good for hard tasks where first attempts often fail',
  async run(ctx) {
    const lessons: string[] = [];
    let best = { output: '', score: -1 };
    let toolCalls = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const msgs: ChatMessage[] = lessons.length
        ? [...ctx.messages.slice(0, -1), { role: 'system', content: `Lessons from previous attempts:\n${lessons.map((l) => `- ${l}`).join('\n')}` }, ctx.messages[ctx.messages.length - 1]!]
        : ctx.messages;
      const r = await ctx.loop(msgs, { stream: false });
      toolCalls += r.toolCalls;
      const s = await ctx.judgment.scoreAnswer(ctx.task, r.output, ctx.runId);
      const score = s?.fraction ?? 1;
      ctx.emit('reflexion.attempt', { attempt, score });
      if (score > best.score) best = { output: r.output, score };
      if (score >= 0.6) break;
      const critique = await ctx.complete([
        { role: 'system', content: 'You review an AI answer. In 1-3 sentences, state what was wrong or missing and how to do better next time.' },
        { role: 'user', content: `Task: ${ctx.task}\n\nAnswer:\n${r.output}` },
      ]);
      lessons.push(critique.trim());
    }
    ctx.onDelta?.(best.output);
    return finalAnswer(best.output, toolCalls, { lessons, score: best.score });
  },
};

export const criticPattern: Pattern = {
  name: 'critic',
  description: 'Critic: produce a draft, have an independent critic review it, then revise; good for writing and important answers',
  async run(ctx) {
    const draft = await ctx.loop(ctx.messages, { stream: false });
    const critique = await ctx.complete([
      { role: 'system', content: 'You are a strict, constructive critic. List concrete problems (errors, gaps, unclear parts) in the draft. If it is already excellent, say "No changes needed."' },
      { role: 'user', content: `Task: ${ctx.task}\n\nDraft:\n${draft.output}` },
    ]);
    ctx.emit('critic.review', { critique: critique.slice(0, 1000) });
    if (/no changes needed/i.test(critique)) {
      ctx.onDelta?.(draft.output);
      return finalAnswer(draft.output, draft.toolCalls, { critique });
    }
    const revised = await ctx.complete(
      [...ctx.messages, { role: 'assistant', content: draft.output }, { role: 'user', content: `A reviewer wrote:\n${critique}\n\nRevise your answer accordingly. Output only the improved answer.` }],
      { stream: true },
    );
    return finalAnswer(revised, draft.toolCalls, { critique });
  },
};
