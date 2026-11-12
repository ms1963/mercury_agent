/**
 * Linear templates:
 *  - single:      one agent does the task.
 *  - pipeline:    agents run in sequence; each receives the previous agent's output.
 *  - round-robin: agents take turns improving a shared draft for N rounds.
 */
import { fillTask, type WorkflowTemplate } from '../types.js';

export const singleTemplate: WorkflowTemplate = {
  type: 'single',
  description: 'One agent handles the whole task',
  async run(ctx) {
    const agent = ctx.spec.agents[0] ?? { name: 'agent' };
    return (await ctx.runAgent(agent, fillTask(agent.task, { input: ctx.input, name: agent.name }))).output;
  },
};

export const pipelineTemplate: WorkflowTemplate = {
  type: 'pipeline',
  description: 'Agents run in sequence, each refining the previous output (e.g. research → write → edit)',
  async run(ctx) {
    let previous = '';
    for (const agent of ctx.spec.agents) {
      const task = fillTask(agent.task ?? (previous ? '{input}\n\nPrevious stage output:\n{previous}' : '{input}'), { input: ctx.input, previous, name: agent.name });
      previous = (await ctx.runAgent(agent, task)).output;
    }
    return previous;
  },
};

export const roundRobinTemplate: WorkflowTemplate = {
  type: 'round-robin',
  description: 'Agents take turns improving one shared draft over several rounds',
  async run(ctx) {
    const rounds = ctx.option('rounds', 2);
    let draft = '';
    for (let r = 0; r < rounds; r++) {
      for (const agent of ctx.spec.agents) {
        const task = draft
          ? `Task: ${ctx.input}\n\nCurrent draft (round ${r + 1}):\n${draft}\n\nImprove the draft from your perspective. Output the full improved draft.`
          : `Task: ${ctx.input}\n\nWrite a first draft.`;
        draft = (await ctx.runAgent(agent, task)).output;
      }
    }
    return draft;
  },
};
