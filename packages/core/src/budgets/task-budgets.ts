/**
 * Per-task hard budgets + running cost-vs-value estimate.
 *
 * The existing {@link BudgetService} enforces recurring per-user/per-model/period quotas.
 * This complements it with HARD budgets scoped to a single task/run: a task may spend at
 * most a fixed cost and/or tokens, and when the cap would be exceeded the task is
 * halted/escalated (a {@link TaskBudgetExceededError} is thrown) instead of silently
 * continuing. While a task runs it also exposes a live cost-vs-value estimate: cost so far,
 * a projection to completion, the configured value/benefit signal and the value/cost ratio.
 *
 * This is real runtime accounting — no mocks. It self-wires to the event bus (opening a
 * task on `run.start`, recording cost on `llm.response`, closing on `run.end`/`run.error`)
 * and the {@link LLMService} calls {@link check} before each model call so an over-budget
 * task is stopped before it spends more.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { EventBus } from '../events/bus.js';
import { TaskBudgetExceededError } from '../types/common.js';

export interface TaskBudgetLimits {
  maxCost?: number;
  maxTokens?: number;
  /** Optional business value/benefit of completing the task, same unit as cost (USD). */
  valueEstimate?: number;
  /** Steps assumed to completion, used to project the final cost. */
  projectedSteps?: number;
}

export type TaskState = 'active' | 'completed' | 'halted' | 'escalated';

export interface TaskBudget {
  taskId: string;
  startedAt: string;
  limits: TaskBudgetLimits;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  state: TaskState;
  /** Why the task was halted/escalated, if applicable. */
  reason?: string;
}

export interface CostVsValue {
  taskId: string;
  state: TaskState;
  costSoFar: number;
  tokens: number;
  calls: number;
  /** Projected total cost at completion (cost so far scaled by remaining steps). */
  projectedCost: number;
  maxCost?: number;
  maxTokens?: number;
  valueEstimate?: number;
  /** valueEstimate / projectedCost (Infinity when cost is 0; undefined when no value set). */
  valueRatio?: number;
  /** Fraction of the cost cap consumed so far (0..1+), undefined when no cap. */
  budgetUsedFraction?: number;
  /** True when continuing is projected to cost more value than it returns. */
  overBudget: boolean;
}

export class TaskBudgetService {
  private tasks = new Map<string, TaskBudget>();

  constructor(private config: MercuryConfig, private bus?: EventBus) {}

  /**
   * Subscribe to the event bus so runs are tracked automatically: a task is opened on
   * `run.start` and closed on `run.end`/`run.error`. Cost is recorded directly by the
   * {@link LLMService} (the authoritative source), not from `llm.response` events, to avoid
   * double-counting. Returns an unsubscribe fn.
   */
  attach(bus: EventBus): () => void {
    const offs = [
      bus.on('run.start', (e) => {
        if (!e.runId) return;
        const d = e.data as { taskBudget?: TaskBudgetLimits; input?: string };
        this.open(e.runId, d.taskBudget);
      }),
      bus.on('run.end', (e) => e.runId && this.complete(e.runId)),
      bus.on('run.error', (e) => e.runId && this.complete(e.runId)),
    ];
    return () => offs.forEach((o) => o());
  }

  /** Begin tracking a task. Caps default to config `budgets.perTask`; explicit limits win. */
  open(taskId: string, limits: TaskBudgetLimits = {}): TaskBudget {
    const existing = this.tasks.get(taskId);
    if (existing && existing.state === 'active') return existing;
    const cfg = this.config.budgets.perTask;
    const t: TaskBudget = {
      taskId,
      startedAt: new Date().toISOString(),
      limits: {
        maxCost: limits.maxCost ?? cfg.maxCost,
        maxTokens: limits.maxTokens ?? cfg.maxTokens,
        valueEstimate: limits.valueEstimate,
        projectedSteps: limits.projectedSteps ?? cfg.projectedSteps,
      },
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      state: 'active',
    };
    this.tasks.set(taskId, t);
    return t;
  }

  get(taskId: string): TaskBudget | undefined {
    return this.tasks.get(taskId);
  }

  active(): TaskBudget[] {
    return [...this.tasks.values()].filter((t) => t.state === 'active');
  }

  all(): TaskBudget[] {
    return [...this.tasks.values()];
  }

  /**
   * Throw if a prospective call of `estimatedCost`/`estimatedTokens` would push the task over
   * its hard cap. Marks the task halted/escalated and emits an event. No-op when per-task
   * budgets are disabled, the task is untracked, or `override` is set.
   */
  check(taskId: string | undefined, estimatedCost = 0, estimatedTokens = 0, override = false): void {
    if (!this.config.budgets.perTask.enabled || override || !taskId) return;
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'active') return;
    const { maxCost, maxTokens } = t.limits;
    const projTokens = t.inputTokens + t.outputTokens + estimatedTokens;
    if (maxCost !== undefined && t.cost + estimatedCost > maxCost) {
      this.trip(t, `task cost budget exceeded: $${(t.cost + estimatedCost).toFixed(4)} > $${maxCost}`);
      throw new TaskBudgetExceededError(t.reason!, taskId);
    }
    if (maxTokens !== undefined && projTokens > maxTokens) {
      this.trip(t, `task token budget exceeded: ${projTokens} > ${maxTokens}`);
      throw new TaskBudgetExceededError(t.reason!, taskId);
    }
  }

  private trip(t: TaskBudget, reason: string): void {
    t.state = this.config.budgets.perTask.onExceed === 'halt' ? 'halted' : 'escalated';
    t.reason = reason;
    this.bus?.emit({ type: 'task.budget.exceeded', runId: t.taskId, data: { taskId: t.taskId, state: t.state, reason, cost: t.cost } });
  }

  /** Record actual spend after a call. Tripping the cap here also halts/escalates the task. */
  record(taskId: string | undefined, cost: number, inputTokens = 0, outputTokens = 0): void {
    if (!taskId) return;
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.cost += cost;
    t.inputTokens += inputTokens;
    t.outputTokens += outputTokens;
    t.calls += 1;
    if (t.state !== 'active') return;
    const { maxCost, maxTokens } = t.limits;
    if (maxCost !== undefined && t.cost > maxCost) this.trip(t, `task cost budget exceeded: $${t.cost.toFixed(4)} > $${maxCost}`);
    else if (maxTokens !== undefined && t.inputTokens + t.outputTokens > maxTokens) this.trip(t, `task token budget exceeded: ${t.inputTokens + t.outputTokens} > ${maxTokens}`);
  }

  /** Mark a still-active task completed (idempotent; leaves halted/escalated states intact). */
  complete(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t && t.state === 'active') t.state = 'completed';
  }

  /** The live cost-vs-value estimate for a task. */
  costVsValue(taskId: string): CostVsValue | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    const tokens = t.inputTokens + t.outputTokens;
    const steps = Math.max(1, t.limits.projectedSteps ?? this.config.budgets.perTask.projectedSteps);
    const done = Math.max(1, t.calls);
    // Project the final cost by scaling the current burn rate up to the assumed step count.
    const projectedCost = t.state === 'completed' ? t.cost : Math.max(t.cost, (t.cost / done) * steps);
    const value = t.limits.valueEstimate;
    const valueRatio = value === undefined ? undefined : projectedCost > 0 ? value / projectedCost : Infinity;
    const budgetUsedFraction = t.limits.maxCost !== undefined && t.limits.maxCost > 0 ? t.cost / t.limits.maxCost : undefined;
    const overBudget = (t.state === 'halted' || t.state === 'escalated') || (value !== undefined && projectedCost > value);
    return {
      taskId: t.taskId,
      state: t.state,
      costSoFar: Math.round(t.cost * 1e6) / 1e6,
      tokens,
      calls: t.calls,
      projectedCost: Math.round(projectedCost * 1e6) / 1e6,
      maxCost: t.limits.maxCost,
      maxTokens: t.limits.maxTokens,
      valueEstimate: value,
      valueRatio: valueRatio === undefined ? undefined : valueRatio === Infinity ? Infinity : Math.round(valueRatio * 1000) / 1000,
      budgetUsedFraction: budgetUsedFraction === undefined ? undefined : Math.round(budgetUsedFraction * 1000) / 1000,
      overBudget,
    };
  }

  /** Drop finished tasks older than `ms` to bound memory. Returns the number removed. */
  prune(ms = 3_600_000): number {
    const cutoff = Date.now() - ms;
    let n = 0;
    for (const [id, t] of this.tasks) {
      if (t.state !== 'active' && new Date(t.startedAt).getTime() < cutoff) {
        this.tasks.delete(id);
        n++;
      }
    }
    return n;
  }
}
