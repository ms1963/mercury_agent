/**
 * Hierarchical templates:
 *  - coordinator-worker: a coordinator splits the task, workers solve subtasks in
 *    parallel (≤ maxSubagents), the coordinator synthesises.
 *  - tree:   recursive decomposition up to `options.depth`; leaves solve, parents merge.
 *  - map-reduce: split input into items, map in parallel, reduce into one answer.
 *  - router: the decision engine picks the single best-suited agent.
 */
import { extractJson } from '../../types/common.js';
import { fillTask, type AgentSpec, type WorkflowContext, type WorkflowTemplate } from '../types.js';

const pick = (ctx: WorkflowContext, name: string, fallbackIndex: number): AgentSpec =>
  ctx.spec.agents.find((a) => a.name === name) ?? ctx.spec.agents[Math.min(fallbackIndex, ctx.spec.agents.length - 1)] ?? { name };

async function split(ctx: WorkflowContext, goal: string, max: number): Promise<string[]> {
  const raw = await ctx.complete(`Split the goal into at most ${max} independent subtasks that can be worked on in parallel. Reply ONLY with JSON: {"steps": ["..."]}`, `GOAL: ${goal}`, true);
  const steps = (extractJson<{ steps?: unknown[] }>(raw)?.steps ?? []).filter((s): s is string => typeof s === 'string' && !!s.trim());
  return (steps.length ? steps : [goal]).slice(0, max);
}

export const coordinatorWorkerTemplate: WorkflowTemplate = {
  type: 'coordinator-worker',
  description: 'A coordinator splits the task, workers solve the parts in parallel, the coordinator merges the results',
  async run(ctx) {
    const coordinator = pick(ctx, 'coordinator', 0);
    const workers = ctx.spec.agents.filter((a) => a !== coordinator);
    const subtasks = await split(ctx, ctx.input, ctx.option('maxTasks', 4));
    ctx.emit('workflow.plan', { subtasks });
    const results = await ctx.runMany(subtasks.map((t, i) => {
      const w = workers.length ? workers[i % workers.length]! : { name: `worker-${i + 1}` };
      return { agent: w, task: fillTask(w.task ?? '{item}\n\n(Part of the larger goal: {input})', { input: ctx.input, item: t, name: w.name }) };
    }));
    const merged = results.map((r, i) => `### Subtask ${i + 1}: ${subtasks[i]}\n${r.output}`).join('\n\n');
    return (await ctx.runAgent(coordinator, `Goal: ${ctx.input}\n\nWorker results:\n${merged}\n\nSynthesise the final answer.`)).output;
  },
};

export const treeTemplate: WorkflowTemplate = {
  type: 'tree',
  description: 'Recursive decomposition: break the task into a tree of subtasks, solve leaves, merge upwards',
  async run(ctx) {
    const maxDepth = ctx.option('depth', 2);
    const branching = ctx.option('branching', 3);
    const solver = pick(ctx, 'solver', 0);
    const merger = pick(ctx, 'merger', 1);
    const solve = async (goal: string, level: number): Promise<string> => {
      const parts = level < maxDepth ? await split(ctx, goal, branching) : [goal];
      if (parts.length <= 1) return (await ctx.runAgent(solver, goal)).output;
      const outs: string[] = [];
      for (const p of parts) outs.push(await solve(p, level + 1));
      return (await ctx.runAgent(merger, `Goal: ${goal}\n\nSub-results:\n${outs.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nMerge into one answer for the goal.`)).output;
    };
    return solve(ctx.input, 1);
  },
};

export const mapReduceTemplate: WorkflowTemplate = {
  type: 'map-reduce',
  description: 'Split input into items (lines, paragraphs or a list), process each in parallel, then combine',
  async run(ctx) {
    const mapper = pick(ctx, 'mapper', 0);
    const reducer = pick(ctx, 'reducer', 1);
    const sep = ctx.option<string>('separator', 'paragraph');
    const explicit = ctx.option<string[]>('items', []);
    const items = explicit.length
      ? explicit
      : ctx.input.split(sep === 'line' ? /\n/ : /\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const instruction = ctx.option('instruction', 'Process this item.');
    const mapped = await ctx.runMany(items.slice(0, ctx.option('maxItems', 20)).map((item) => ({ agent: mapper, task: fillTask(mapper.task ?? `${instruction}\n\nItem:\n{item}`, { input: ctx.input, item, name: mapper.name }) })));
    return (await ctx.runAgent(reducer, fillTask(reducer.task ?? 'Combine these partial results into one coherent answer.\n\n{previous}', { input: ctx.input, previous: mapped.map((m, i) => `${i + 1}. ${m.output}`).join('\n'), name: reducer.name }))).output;
  },
};

export const routerTemplate: WorkflowTemplate = {
  type: 'router',
  description: 'The decision engine routes the task to the single best-suited specialist agent',
  async run(ctx) {
    const options = Object.fromEntries(ctx.spec.agents.map((a) => [a.name, a.role ?? a.name]));
    const choice = await ctx.judgment.engine.choice({ task: ctx.input }, 'Which specialist agent should handle this task?', options, 'workflow_router', ctx.runId).catch(() => undefined);
    const agent = ctx.spec.agents.find((a) => a.name === choice?.choice) ?? ctx.spec.agents[0]!;
    ctx.emit('workflow.routed', { agent: agent.name, confidence: choice?.confidence });
    return (await ctx.runAgent(agent, fillTask(agent.task, { input: ctx.input, name: agent.name }))).output;
  },
};
