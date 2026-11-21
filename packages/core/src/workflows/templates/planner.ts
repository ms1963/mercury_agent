/**
 * Planner-executor template — the fix for "workflows terminate too quickly".
 *
 * Instead of a single-shot run, this template:
 *  - asks a planner (one structured LLM call) to decompose the goal into an ordered list of
 *    concrete steps, between `minSteps` and `maxSteps`, aiming for `targetSteps`;
 *  - runs each step with an executor agent, feeding it the accumulated results of prior steps,
 *    so each step is substantive and builds on the last (one `workflow.step` per step);
 *  - on a failed step, if `replanOnFailure` is set, re-plans the remaining work once and
 *    continues (bounded by the hard `maxSteps` cap and the workflow budget — no runaway);
 *  - synthesises all step outputs into one final answer.
 *
 * Step budget defaults come from config.workflows.planner (via ctx.planner) and can be
 * overridden per workflow through spec.options (minSteps/targetSteps/maxSteps/replanOnFailure).
 * Planning degrades gracefully: when the LLM returns no usable JSON (e.g. the mock provider),
 * the plan is padded with generic steps so the workflow still runs the configured depth.
 */
import { extractJson } from '../../types/common.js';
import { fillTask, type WorkflowContext, type WorkflowTemplate } from '../types.js';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)));

/** Deterministic fallback steps so a plan always reaches the configured minimum depth. */
function genericSteps(goal: string, n: number): string[] {
  const base = [
    `Clarify the goal and identify what sub-results are needed for: ${goal}`,
    `Gather the information and context required for: ${goal}`,
    `Produce the core part of the solution for: ${goal}`,
    `Review the work so far for correctness and gaps`,
    `Refine and expand the solution where it is weak`,
    `Verify the result against the original goal`,
    `Finalise and format the complete answer`,
  ];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(base[i] ?? `Continue working towards the goal (step ${i + 1}): ${goal}`);
  return out;
}

async function planSteps(ctx: WorkflowContext, goal: string, target: number, min: number, max: number, priorFailure?: string): Promise<string[]> {
  const ask = priorFailure
    ? `A previous step failed with: ${priorFailure}\nRevise the REMAINING plan to recover and still reach the goal. Reply ONLY with JSON: {"steps": ["..."]}`
    : `Decompose the GOAL into about ${target} concrete, ordered steps that together fully solve it. Each step must be a single actionable instruction. Reply ONLY with JSON: {"steps": ["..."]}`;
  let steps: string[] = [];
  try {
    const raw = await ctx.complete(ask, `GOAL: ${goal}`, true);
    steps = (extractJson<{ steps?: unknown[] }>(raw)?.steps ?? []).filter((s): s is string => typeof s === 'string' && !!s.trim());
  } catch {
    steps = [];
  }
  if (steps.length < min) steps = steps.concat(genericSteps(goal, min - steps.length));
  return steps.slice(0, max);
}

export const plannerExecutorTemplate: WorkflowTemplate = {
  type: 'planner-executor',
  description: 'A planner decomposes the task into several steps; an executor runs them in order, re-planning on failure, then synthesises the result',
  async run(ctx) {
    const d = ctx.planner;
    const min = clamp(ctx.option('minSteps', d?.minSteps ?? 3), 1, 50);
    const max = clamp(ctx.option('maxSteps', d?.maxSteps ?? 12), min, 50);
    const target = clamp(ctx.option('targetSteps', d?.targetSteps ?? 5), min, max);
    const replan = ctx.option('replanOnFailure', d?.replanOnFailure ?? true);

    const executor =
      ctx.spec.agents.find((a) => a.name === 'executor') ??
      ctx.spec.agents.find((a) => a.name !== 'planner' && a.name !== 'synthesizer') ??
      ctx.spec.agents[0] ?? { name: 'executor' };
    const synthAgent = ctx.spec.agents.find((a) => a.name === 'synthesizer');

    let plan = await planSteps(ctx, ctx.input, target, min, max);
    ctx.emit('workflow.plan', { steps: plan });

    const results: string[] = [];
    let executed = 0;
    let replanned = false;
    for (let i = 0; i < plan.length && executed < max; i++) {
      const stepGoal = plan[i]!;
      const context = results.length ? results.join('\n\n') : '(nothing yet)';
      const role = fillTask(executor.task, { input: ctx.input, name: executor.name });
      const prompt = `${role ? role + '\n\n' : ''}Overall goal: ${ctx.input}\n\nThis step (${i + 1} of ${plan.length}): ${stepGoal}\n\nResults so far:\n${context}\n\nComplete THIS step only and output its result.`;
      const r = await ctx.runAgent(executor, prompt);
      executed++;
      results.push(`[Step ${i + 1}: ${stepGoal}]\n${r.output}`);
      if (r.status !== 'completed' && replan && !replanned && executed < max) {
        replanned = true;
        const recovery = await planSteps(ctx, ctx.input, target, min, max, (r.output ?? '').slice(0, 300));
        ctx.emit('workflow.replan', { steps: recovery });
        plan = [...plan.slice(0, i + 1), ...recovery].slice(0, i + 1 + max);
      }
    }

    const combined = results.join('\n\n');
    if (synthAgent) return (await ctx.runAgent(synthAgent, `Goal: ${ctx.input}\n\nStep results:\n${combined}\n\nSynthesise the final, complete answer.`)).output;
    const synth = await ctx.complete('Synthesise the final, complete answer to the goal from the step results below. Be comprehensive and self-contained.', `Goal: ${ctx.input}\n\nStep results:\n${combined}`);
    return synth.trim() || combined;
  },
};
