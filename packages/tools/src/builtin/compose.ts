/**
 * Skill composition tool (toolset "skills").
 *
 * `skill_compose` runs a small pipeline that can invoke other TOOLS and nested sub-skills,
 * reusing the REAL tool executor (so policy, approval, audit and SSRF guards all still apply to
 * every tool step). Intermediate results are cached and recursion is guarded (depth limit + cycle
 * detection + a step budget) by the {@link SkillComposer} behind `ctx.services.composition`.
 */
import { defineTool, type AnyTool, type CompositionSpec } from '@mercury/core';
import { anyObj, arr, params, str } from '../util.js';

interface ComposeArgs {
  skill: string;
  steps: Array<{ tool?: string; args?: Record<string, unknown>; skill?: string; steps?: unknown[]; inputs?: Record<string, unknown>; label?: string }>;
  inputs?: Record<string, unknown>;
}

export const skillCompose = defineTool<ComposeArgs>({
  name: 'skill_compose',
  description:
    'Run a composed skill: an ordered pipeline of tool calls and nested sub-skills. Each step is {tool, args} to call a tool, or {skill, steps, inputs} to run a nested sub-skill. Intermediate results are cached; recursion is depth- and cycle-guarded. Every tool step still goes through normal policy/approval.',
  toolset: 'skills',
  risk: 'moderate',
  parameters: params(
    {
      skill: str('Name for this composition (used for caching and cycle detection)'),
      steps: arr(anyObj('{tool, args} or {skill, steps, inputs, label}'), 'Ordered pipeline steps'),
      inputs: anyObj('Static inputs for the composition (part of its cache key)'),
    },
    ['skill', 'steps'],
  ),
  async execute(a, ctx) {
    const composer = ctx.services.composition;
    if (!composer) return { content: 'Skill composition is not available (config.composition.enabled is off).', isError: true };
    const spec: CompositionSpec = { skill: a.skill, inputs: a.inputs, steps: (a.steps ?? []) as CompositionSpec['steps'] };
    try {
      const result = await composer.run(spec, ctx);
      const header = `[composition ${result.skill}${result.cached ? ', cached' : ''}, ${result.steps.length} step(s)]`;
      return { content: `${header}\n${result.output}`, data: { cached: result.cached, steps: result.steps.map((s) => ({ label: s.label, kind: s.kind, name: s.name, ok: s.ok, cached: s.cached })) }, isError: result.steps.some((s) => !s.ok) };
    } catch (err) {
      return { content: `Composition failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
});

export const composeTools: AnyTool[] = [skillCompose];
