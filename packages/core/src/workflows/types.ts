/**
 * Multi-agent workflow contracts.
 *
 * A WorkflowSpec (YAML/JSON in `workflows/`) names a template `type` and lists the
 * agents taking part. A WorkflowTemplate (TypeScript class/object) implements the
 * coordination strategy. New strategies are added by registering a template
 * (plugins: `api.registerWorkflowTemplate`), new configurations by dropping a YAML file.
 */
import type { Blackboard } from '../memory/blackboard.js';
import type { Judgment } from '../decision/judgment.js';
import type { Principal } from '../types/common.js';
import type { RunResult } from '../agent/agent.js';

export interface AgentSpec {
  name: string;
  /** Role/instructions appended to the agent's system prompt. */
  role?: string;
  model?: string;
  pattern?: string;
  toolsets?: string[];
  /** Task template; placeholders: {input} {previous} {context} {item} {name}. */
  task?: string;
}

export interface WorkflowBudget {
  maxSubagents?: number;
  maxDepth?: number;
  /** Max agent runs in total for one workflow run. */
  maxRuns?: number;
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  type: string;
  agents: AgentSpec[];
  options?: Record<string, unknown>;
  budget?: WorkflowBudget;
}

export interface WorkflowStep {
  agent: string;
  input: string;
  output: string;
  runId?: string;
  status?: string;
}

export interface WorkflowResult {
  output: string;
  steps: WorkflowStep[];
}

/** Default step budget for the planner-executor template (from config.workflows.planner). */
export interface PlannerDefaults {
  minSteps: number;
  targetSteps: number;
  maxSteps: number;
  replanOnFailure: boolean;
}

export interface WorkflowContext {
  spec: WorkflowSpec;
  input: string;
  principal: Principal;
  runId: string;
  signal: AbortSignal;
  judgment: Judgment;
  blackboard: Blackboard;
  /** Planner-executor step budget defaults (from config); overridable via spec.options. */
  planner?: PlannerDefaults;
  /** Run one agent of the spec as a subagent (budget/depth enforced). */
  runAgent(agent: AgentSpec, task: string): Promise<RunResult>;
  /** Run several agent tasks concurrently (limited to maxSubagents). */
  runMany(items: Array<{ agent: AgentSpec; task: string }>): Promise<RunResult[]>;
  /** Single structured LLM call (planning, splitting, judging). */
  complete(system: string, user: string, json?: boolean): Promise<string>;
  emit(type: string, data: Record<string, unknown>): void;
  steps: WorkflowStep[];
  option<T>(key: string, fallback: T): T;
}

export interface WorkflowTemplate {
  type: string;
  description: string;
  run(ctx: WorkflowContext): Promise<string>;
}

/** Fill `{placeholders}` in a task template. */
export function fillTask(template: string | undefined, vars: Record<string, string>): string {
  const t = template ?? '{input}{context}';
  return t.replace(/\{(\w+)\}/g, (_, k: string) => (k === 'context' ? (vars.context ? `\n\nContext:\n${vars.context}` : '') : (vars[k] ?? '')));
}
