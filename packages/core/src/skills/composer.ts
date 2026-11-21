/**
 * SkillComposer — lets a skill (or an ad-hoc composition) invoke other skills AND tools as a
 * small pipeline, reusing the REAL tool executor (policy, approval, audit, chaos all apply).
 *
 *  - Intermediate results are cached, keyed on skill + inputs, with a bounded TTL cache
 *    (reuses {@link TtlCache}) so repeated sub-skills are not recomputed.
 *  - Infinite recursion is guarded two ways: a hard depth limit (config.composition.maxDepth)
 *    and cycle detection on the active skill stack. A per-composition step budget bounds width.
 *
 * This is additive: nothing runs it unless the `skill_compose` tool (or an explicit caller) is
 * used. The executor enforces all existing security on every tool step.
 */
import type { MercuryConfig } from '../config/schema.js';
import { TtlCache } from '../reliability/cache.js';
import type { SkillRegistry } from './registry.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../types/common.js';

/** One step of a composition: either a tool call or a nested sub-skill composition. */
export interface CompositionStep {
  /** Invoke a registered tool with these arguments. */
  tool?: string;
  args?: Record<string, unknown>;
  /** Invoke a nested sub-skill composition by name. */
  skill?: string;
  /** Steps of the nested sub-skill (used when `skill` is set). */
  steps?: CompositionStep[];
  /** Static inputs for the nested sub-skill (part of its cache key). */
  inputs?: Record<string, unknown>;
  /** Optional label for the step's output in the combined result. */
  label?: string;
}

/** A composition: a named skill plus the ordered steps it runs. */
export interface CompositionSpec {
  skill: string;
  inputs?: Record<string, unknown>;
  steps: CompositionStep[];
}

export interface CompositionStepResult {
  label: string;
  kind: 'tool' | 'skill';
  name: string;
  output: string;
  ok: boolean;
  cached?: boolean;
}

export interface CompositionResult {
  skill: string;
  cached: boolean;
  steps: CompositionStepResult[];
  output: string;
}

export class SkillComposer {
  private cache?: TtlCache<string, CompositionResult>;

  constructor(
    private config: MercuryConfig,
    private skills?: SkillRegistry,
  ) {
    const c = config.composition.cache;
    if (c.enabled) this.cache = new TtlCache<string, CompositionResult>({ maxSize: c.maxSize, ttlMs: c.ttlMs });
  }

  /** Clear the intermediate-result cache (tests / maintenance). */
  clearCache(): void {
    this.cache?.clear();
  }

  private cacheKey(spec: CompositionSpec): string {
    return `${spec.skill}|${JSON.stringify(spec.inputs ?? {})}|${JSON.stringify(spec.steps)}`;
  }

  /**
   * Run a composition. `stack` tracks the active sub-skill chain for cycle detection — callers
   * pass nothing; the recursion fills it.
   */
  async run(spec: CompositionSpec, ctx: ToolContext, stack: string[] = []): Promise<CompositionResult> {
    if (!this.config.composition.enabled) throw new Error('skill composition is disabled (config.composition.enabled)');
    if (stack.length >= this.config.composition.maxDepth) {
      throw new Error(`skill composition depth limit (${this.config.composition.maxDepth}) exceeded at "${spec.skill}"`);
    }
    if (stack.includes(spec.skill)) {
      throw new Error(`skill composition cycle detected: ${[...stack, spec.skill].join(' → ')}`);
    }

    const key = this.cacheKey(spec);
    if (this.cache?.has(key)) {
      const cached = this.cache.get(key)!;
      return { ...cached, cached: true };
    }

    const steps: CompositionStepResult[] = [];
    let count = 0;
    let allOk = true;
    for (const step of spec.steps) {
      if (++count > this.config.composition.maxSteps) throw new Error(`skill composition step budget (${this.config.composition.maxSteps}) exceeded`);
      if (step.skill) {
        const sub = await this.run({ skill: step.skill, inputs: step.inputs, steps: step.steps ?? [] }, ctx, [...stack, spec.skill]);
        steps.push({ label: step.label ?? step.skill, kind: 'skill', name: step.skill, output: sub.output, ok: true, cached: sub.cached });
      } else if (step.tool) {
        const exec = await this.runTool(step.tool, step.args ?? {}, ctx);
        allOk = allOk && exec.ok;
        steps.push({ label: step.label ?? step.tool, kind: 'tool', name: step.tool, output: exec.modelContent, ok: exec.ok, cached: false });
      } else {
        throw new Error('composition step must set either "tool" or "skill"');
      }
    }

    const output = steps.map((s) => `[${s.label}] ${s.output}`).join('\n');
    const result: CompositionResult = { skill: spec.skill, cached: false, steps, output };
    this.cache?.set(key, result);
    try {
      this.skills?.recordUse(spec.skill, allOk);
    } catch {
      /* recording skill use is best-effort */
    }
    return result;
  }

  private async runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ modelContent: string; ok: boolean }> {
    const executor = ctx.services.executor as ToolExecutor | undefined;
    if (!executor) throw new Error('composition needs the tool executor (services.executor)');
    const call = { id: newId('call'), name, arguments: args };
    const exec = await executor.execute(call, ctx, { untrustedSeen: false, userRequest: '' });
    return { modelContent: exec.modelContent, ok: exec.ok };
  }
}
