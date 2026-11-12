/**
 * Collaborative templates:
 *  - blackboard: specialists read a shared blackboard and post contributions over
 *    several rounds; a synthesiser writes the final answer from the board.
 *  - debate: agents argue positions for N rounds; a judge agent (or the decision
 *    engine when no judge is defined) picks/synthesises the conclusion.
 */
import type { WorkflowTemplate } from '../types.js';

export const blackboardTemplate: WorkflowTemplate = {
  type: 'blackboard',
  description: 'Specialists collaborate through a shared blackboard over several rounds; a synthesiser concludes',
  async run(ctx) {
    const rounds = ctx.option('rounds', 2);
    const synth = ctx.spec.agents.find((a) => a.name === 'synthesizer');
    const experts = ctx.spec.agents.filter((a) => a !== synth);
    ctx.blackboard.post(ctx.runId, 'task', ctx.input, 'user');
    for (let r = 0; r < rounds; r++) {
      for (const agent of experts) {
        const board = ctx.blackboard.render(ctx.runId);
        const out = await ctx.runAgent(agent, `Shared task: ${ctx.input}\n\nBlackboard so far:\n${board}\n\nAdd your most useful new contribution (facts, partial solutions, corrections). Do not repeat what is already there.`);
        ctx.blackboard.post(ctx.runId, `round${r + 1}`, out.output, agent.name);
      }
    }
    const board = ctx.blackboard.render(ctx.runId);
    if (synth) return (await ctx.runAgent(synth, `Task: ${ctx.input}\n\nBlackboard:\n${board}\n\nWrite the final answer.`)).output;
    return ctx.complete('Write the final answer to the task using the blackboard contributions.', `Task: ${ctx.input}\n\nBlackboard:\n${board}`);
  },
};

export const debateTemplate: WorkflowTemplate = {
  type: 'debate',
  description: 'Agents debate opposing positions for several rounds; a judge decides',
  async run(ctx) {
    const rounds = ctx.option('rounds', 2);
    const judge = ctx.spec.agents.find((a) => a.name === 'judge');
    const debaters = ctx.spec.agents.filter((a) => a !== judge);
    const transcript: string[] = [];
    for (let r = 0; r < rounds; r++) {
      for (const agent of debaters) {
        const out = await ctx.runAgent(agent, `Debate topic: ${ctx.input}\n\nTranscript so far:\n${transcript.join('\n\n') || '(you open the debate)'}\n\nGive your argument for round ${r + 1}, responding to the others.`);
        transcript.push(`**${agent.name}** (round ${r + 1}): ${out.output}`);
      }
    }
    if (judge) return (await ctx.runAgent(judge, `Topic: ${ctx.input}\n\nDebate transcript:\n${transcript.join('\n\n')}\n\nDecide which position is best supported and give the final conclusion with reasons.`)).output;
    const options = Object.fromEntries(debaters.map((d) => [d.name, transcript.filter((t) => t.startsWith(`**${d.name}**`)).join(' ').slice(0, 800)]));
    const verdict = await ctx.judgment.engine.choice({ topic: ctx.input }, 'Whose arguments are most convincing and best supported?', options, 'debate_judge', ctx.runId).catch(() => undefined);
    return `Debate winner: ${verdict?.choice ?? debaters[0]?.name ?? 'n/a'}${verdict?.confidence !== undefined ? ` (confidence ${verdict.confidence.toFixed(2)})` : ''}\n\n${transcript.join('\n\n')}`;
  },
};
