/**
 * Spawner — creates subagents (Hermes `delegate_task`) with isolation and limits:
 *   - each subagent runs with a fresh, ephemeral context (no parent history)
 *   - optional restricted toolsets / model / pattern / role
 *   - depth limit (config.agent.maxDepth): a subagent at max depth cannot delegate
 *   - concurrency limit per parent run (config.agent.maxSubagents, default 3)
 *   - optional total-run budget per parent (workflow budgets)
 * Subagent runs are linked to their parent (runs.parent_run_id) for the run-tree viewer.
 */
import type { MercuryConfig } from '../config/schema.js';
import { MercuryError, Semaphore, type Principal } from '../types/common.js';
import type { Agent, RunResult } from '../agent/agent.js';

export interface ParentInfo {
  principal: Principal;
  runId: string;
  depth: number;
  platform: string;
  signal?: AbortSignal;
  /** Override limits for this parent (workflow budgets). */
  maxSubagents?: number;
  maxDepth?: number;
  maxRuns?: number;
}

export interface SubagentTask {
  goal: string;
  context?: string;
  role?: string;
  toolsets?: string[];
  model?: string;
  pattern?: string;
  name?: string;
}

export class Spawner {
  private semaphores = new Map<string, Semaphore>();
  private runCounts = new Map<string, number>();

  constructor(private config: MercuryConfig, private agent: Agent) {}

  limits(parent: ParentInfo): { maxSubagents: number; maxDepth: number; maxRuns?: number } {
    return { maxSubagents: parent.maxSubagents ?? this.config.agent.maxSubagents, maxDepth: parent.maxDepth ?? this.config.agent.maxDepth, maxRuns: parent.maxRuns };
  }

  canSpawn(parent: ParentInfo): boolean {
    return parent.depth + 1 <= this.limits(parent).maxDepth;
  }

  async spawn(parent: ParentInfo, task: SubagentTask): Promise<RunResult> {
    const lim = this.limits(parent);
    if (parent.depth + 1 > lim.maxDepth) throw new MercuryError(`Subagent depth limit reached (max ${lim.maxDepth})`, 'depth_limit', 'multi-agent');
    const count = (this.runCounts.get(parent.runId) ?? 0) + 1;
    if (lim.maxRuns && count > lim.maxRuns) throw new MercuryError(`Workflow run budget exhausted (max ${lim.maxRuns} agent runs)`, 'run_budget', 'workflows');
    this.runCounts.set(parent.runId, count);

    let sem = this.semaphores.get(parent.runId);
    if (!sem) this.semaphores.set(parent.runId, (sem = new Semaphore(lim.maxSubagents)));
    const release = await sem.acquire();
    try {
      // Subagents may only delegate further when depth allows; otherwise strip the agents toolset.
      const canDelegate = parent.depth + 2 <= lim.maxDepth;
      const toolsets = task.toolsets ?? (canDelegate ? undefined : this.nonDelegatingToolsets());
      return await this.agent.run({
        principal: parent.principal,
        input: task.context ? `${task.goal}\n\nContext from the delegating agent:\n${task.context}` : task.goal,
        platform: parent.platform,
        depth: parent.depth + 1,
        parentRunId: parent.runId,
        ephemeral: true,
        kind: 'subagent',
        toolsets,
        model: task.model,
        pattern: task.pattern,
        systemExtra: task.role ? `## Your role${task.name ? ` (${task.name})` : ''}\n${task.role}` : undefined,
        signal: parent.signal,
        reflect: false,
      });
    } finally {
      release();
    }
  }

  /** Run tasks concurrently, bounded by maxSubagents. Results keep input order. */
  async spawnMany(parent: ParentInfo, tasks: SubagentTask[]): Promise<RunResult[]> {
    return Promise.all(tasks.map((t) => this.spawn(parent, t)));
  }

  /** Free per-parent bookkeeping once the parent run ended. */
  release(parentRunId: string): void {
    this.semaphores.delete(parentRunId);
    this.runCounts.delete(parentRunId);
  }

  private nonDelegatingToolsets(): string[] {
    return this.agent.deps.tools.toolsets().filter((t) => t.name !== 'agents').map((t) => t.name);
  }
}
