/**
 * TeamsService — define, persist and run multi-agent teams.
 *
 * Running a team orchestrates its members according to the chosen {@link TeamStrategy}:
 *   - coordinator: member[0] coordinates; the rest work in parallel on the task, then the
 *     coordinator synthesizes their results (falling back to concatenation).
 *   - pipeline: members run in sequence, each receiving the previous output as context.
 *   - debate: every member answers independently, then the results are aggregated/voted.
 *
 * Member failures are handled GRACEFULLY — a member that errors is recorded in the trace with
 * status `error` and the run continues, aggregating whatever succeeded (it never rejects the whole
 * run). Runs are governed: an optional approval gate, an auth-policy check (`teams.run`) and a hard
 * per-run cost ceiling. Delegation reuses the workflow spawner via the injected {@link TeamDelegate};
 * the blackboard is shared so members can post/read intermediate findings.
 */
import type { PolicyEngine } from '../auth/policy.js';
import type { MercuryConfig } from '../config/schema.js';
import type { EventBus } from '../events/bus.js';
import type { Blackboard } from '../memory/blackboard.js';
import type { AuditLog } from '../security/audit.js';
import { MercuryError, newId, nowIso, type Principal } from '../types/common.js';
import type {
  NewTeam,
  TeamDefinition,
  TeamDelegate,
  TeamMember,
  TeamRunRecord,
  TeamRunStep,
  TeamRunStatus,
  TeamStore,
  TeamStrategy,
  TeamSynthesizer,
} from './ports.js';

export interface TeamsServiceOptions {
  delegate: TeamDelegate;
  policy?: PolicyEngine;
  audit?: AuditLog;
  bus?: EventBus;
  blackboard?: Blackboard;
  synthesizer?: TeamSynthesizer;
}

export interface TeamRunOptions {
  /** Explicit approval flag (required when config.teams.requireApproval is set). */
  approve?: boolean;
  /** Override the per-run cost ceiling (USD); falls back to config.teams.budget. */
  budget?: number;
  signal?: AbortSignal;
}

const fillTask = (template: string | undefined, task: string, context?: string): string => {
  if (!template) return context ? `${task}\n\nContext:\n${context}` : task;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k === 'task' ? task : k === 'context' ? (context ?? '') : ''));
};

export class TeamsService {
  constructor(
    private store: TeamStore,
    private config: MercuryConfig,
    private opts: TeamsServiceOptions,
  ) {}

  private ensureEnabled(): void {
    if (!this.config.teams.enabled) {
      throw new MercuryError('Teams are disabled. Set teams.enabled = true to use multi-agent orchestration.', 'teams_disabled', 'teams', 400);
    }
  }

  /** Create or update a team definition (governed: validates strategy + member count). */
  define(principal: Principal | undefined, team: NewTeam): TeamDefinition {
    this.ensureEnabled();
    if (this.opts.policy && principal) this.opts.policy.assert(principal, 'teams.manage');
    if (!team.name?.trim()) throw new MercuryError('Team name is required', 'invalid_team', 'teams', 400);
    if (!team.members?.length) throw new MercuryError('A team needs at least one member', 'invalid_team', 'teams', 400);
    if (team.members.length > this.config.teams.maxMembers) {
      throw new MercuryError(`A team may have at most ${this.config.teams.maxMembers} members`, 'invalid_team', 'teams', 400);
    }
    const strategy: TeamStrategy = team.strategy ?? this.config.teams.defaultStrategy;
    const def = this.store.create({ ...team, strategy });
    this.opts.audit?.record(principal?.username ?? 'system', 'team.define', def.name, { strategy, members: def.members.length });
    this.opts.bus?.emit({ type: 'team.define', data: { name: def.name, strategy, members: def.members.length } });
    return def;
  }

  list(): TeamDefinition[] {
    return this.store.list();
  }
  get(idOrName: string): TeamDefinition | undefined {
    return this.store.get(idOrName) ?? this.store.getByName(idOrName);
  }
  delete(principal: Principal | undefined, idOrName: string): boolean {
    if (this.opts.policy && principal) this.opts.policy.assert(principal, 'teams.manage');
    const def = this.get(idOrName);
    if (!def) return false;
    const ok = this.store.remove(def.id);
    if (ok) this.opts.audit?.record(principal?.username ?? 'system', 'team.delete', def.name, {});
    return ok;
  }

  getRun(id: string): TeamRunRecord | undefined {
    return this.store.getRun(id);
  }
  listRuns(teamId?: string, limit?: number, userId?: string): TeamRunRecord[] {
    return this.store.listRuns(teamId, limit, userId);
  }

  /** Run a team on a task. Returns the persisted run record (never throws for a member failure). */
  async run(principal: Principal, idOrName: string, task: string, opts: TeamRunOptions = {}): Promise<TeamRunRecord> {
    this.ensureEnabled();
    if (this.opts.policy) this.opts.policy.assert(principal, 'teams.run');
    if (this.config.teams.requireApproval && !opts.approve) {
      throw new MercuryError('This team run requires approval. Re-run with approval to proceed.', 'approval_required', 'teams', 403);
    }
    const def = this.get(idOrName);
    if (!def) throw new MercuryError(`Team not found: ${idOrName}`, 'not_found', 'teams', 404);
    if (!task?.trim()) throw new MercuryError('A task is required to run a team', 'invalid_task', 'teams', 400);

    const ceiling = opts.budget ?? this.config.teams.budget;
    const runId = newId('teamrun');
    const startedAt = nowIso();
    const trace: TeamRunStep[] = [];
    const state = { cost: 0, budgetHit: false };

    // Delegate wrapper: enforces the budget ceiling and degrades gracefully (never throws).
    const delegate = async (member: TeamMember, memberRole: TeamRunStep['role'], subtask: string, context?: string): Promise<TeamRunStep> => {
      if (ceiling > 0 && state.cost >= ceiling) {
        state.budgetHit = true;
        const step: TeamRunStep = { member: member.name, role: memberRole, task: subtask, output: '', status: 'skipped', cost: 0, error: 'budget ceiling reached' };
        trace.push(step);
        return step;
      }
      let step: TeamRunStep;
      try {
        const res = await this.opts.delegate({ member, task: fillTask(member.task, subtask, context), context, principal, runId, depth: 0, signal: opts.signal });
        state.cost += res.cost;
        step = { member: member.name, role: memberRole, task: subtask, output: res.output, status: res.status, cost: res.cost, runId: res.runId, error: res.error };
        // Share successful member output on the blackboard for other members.
        if (res.status === 'completed' && this.opts.blackboard) {
          try { this.opts.blackboard.post(runId, `team:${member.name}`, res.output.slice(0, 4000)); } catch { /* best effort */ }
        }
      } catch (err) {
        // Graceful degradation: a thrown delegate failure becomes a recorded error step.
        step = { member: member.name, role: memberRole, task: subtask, output: '', status: 'error', cost: 0, error: err instanceof Error ? err.message : String(err) };
      }
      trace.push(step);
      if (ceiling > 0 && state.cost >= ceiling) state.budgetHit = true;
      return step;
    };

    let output = '';
    if (def.strategy === 'pipeline') output = await this.runPipeline(def, task, delegate);
    else if (def.strategy === 'debate') output = await this.runDebate(def, task, delegate);
    else output = await this.runCoordinator(def, task, delegate);

    const succeeded = trace.filter((s) => s.status === 'completed' || s.status === 'stopped').length;
    const failed = trace.filter((s) => s.status === 'error' || s.status === 'blocked').length;
    const status: TeamRunStatus = state.budgetHit && succeeded < def.members.length ? 'blocked' : failed === 0 && succeeded > 0 ? 'completed' : succeeded === 0 ? 'error' : 'partial';

    const record = this.store.recordRun({
      teamId: def.id,
      teamName: def.name,
      task,
      strategy: def.strategy,
      status,
      output,
      members: def.members.length,
      succeeded,
      failed,
      cost: state.cost,
      trace,
      error: status === 'error' ? 'all members failed' : state.budgetHit ? 'budget ceiling reached' : undefined,
      startedAt,
      endedAt: nowIso(),
      userId: principal.userId,
    });
    this.opts.audit?.record(principal.username, 'team.run', def.name, { status, cost: state.cost, succeeded, failed });
    this.opts.bus?.emit({ type: 'team.run', userId: principal.userId, data: { team: def.name, status, cost: state.cost, succeeded, failed } });
    return record;
  }

  // --- strategies -------------------------------------------------------------

  private async runCoordinator(def: TeamDefinition, task: string, delegate: (m: TeamMember, r: TeamRunStep['role'], t: string, c?: string) => Promise<TeamRunStep>): Promise<string> {
    const [first, ...rest] = def.members;
    const workers = rest.length ? rest : def.members;
    const coordinator = rest.length ? first : undefined;
    let directive = task;
    if (coordinator) {
      const plan = await delegate(coordinator, 'coordinator', `Plan how the team should approach this task and give direction to the workers:\n${task}`);
      if (plan.status === 'completed' && plan.output.trim()) directive = `${task}\n\nCoordinator direction:\n${plan.output}`;
    }
    const results = await Promise.all(workers.map((w) => delegate(w, 'worker', task, directive)));
    const good = results.filter((r) => r.status === 'completed' && r.output.trim());
    if (!good.length) return '';
    const combined = good.map((r) => `### ${r.member}\n${r.output}`).join('\n\n');
    if (coordinator && this.opts.synthesizer) {
      try {
        return await this.opts.synthesizer(
          `You are ${coordinator.name}, the team coordinator. Synthesize the workers' results into one coherent answer.`,
          `Task:\n${task}\n\nWorker results:\n${combined}`,
        );
      } catch { /* fall through to concatenation */ }
    }
    return combined;
  }

  private async runPipeline(def: TeamDefinition, task: string, delegate: (m: TeamMember, r: TeamRunStep['role'], t: string, c?: string) => Promise<TeamRunStep>): Promise<string> {
    let carry = '';
    let last = '';
    for (const member of def.members) {
      const step = await delegate(member, 'stage', task, carry || undefined);
      if (step.status === 'completed' && step.output.trim()) {
        carry = step.output;
        last = step.output;
      }
      // On failure, keep the last good output as the carry so the pipeline degrades gracefully.
    }
    return last || carry;
  }

  private async runDebate(def: TeamDefinition, task: string, delegate: (m: TeamMember, r: TeamRunStep['role'], t: string, c?: string) => Promise<TeamRunStep>): Promise<string> {
    const results = await Promise.all(def.members.map((m) => delegate(m, 'debater', task)));
    const positions = results.filter((r) => r.status === 'completed' && r.output.trim());
    if (!positions.length) return '';
    const combined = positions.map((r) => `### ${r.member}\n${r.output}`).join('\n\n');
    if (this.opts.synthesizer) {
      try {
        return await this.opts.synthesizer(
          'You are the judge of a multi-agent debate. Weigh the positions and produce the single best answer.',
          `Task:\n${task}\n\nPositions:\n${combined}`,
        );
      } catch { /* fall through */ }
    }
    // No synthesizer: pick the longest (most complete) position, keeping all positions visible.
    const best = positions.reduce((a, b) => (b.output.length > a.output.length ? b : a));
    return `${best.output}\n\n---\nPositions considered:\n${combined}`;
  }
}
