/**
 * Multi-agent orchestration ("teams") — data model + store port.
 *
 * A {@link TeamDefinition} is a named, persisted configuration of several roles/agents plus an
 * orchestration {@link TeamStrategy} (coordinator→workers, pipeline, or debate/vote). Running a team
 * on a task delegates subtasks to its members (reusing the workflow spawner + blackboard), aggregates
 * their results, and degrades gracefully when a member fails (a failing member never crashes the run).
 * Every run is governed (per-run budget ceiling, optional approval, policy) and auditable; the
 * {@link TeamRunRecord} persists the task, status, aggregated output and the full delegation trace.
 *
 * Persistence goes through the {@link TeamStore} port (one real SQLite implementation in `store.ts`);
 * the service depends only on this interface and on an injected {@link TeamDelegate} — mirroring the
 * evals convention (no mocks in product code; the same real store is used in tests).
 */
import type { Principal } from '../types/common.js';

/** Orchestration strategies a team can run. */
export type TeamStrategy = 'coordinator' | 'pipeline' | 'debate';

/** One member (role/agent) of a team. */
export interface TeamMember {
  name: string;
  /** Role/instructions appended to the member's system prompt. */
  role?: string;
  model?: string;
  pattern?: string;
  toolsets?: string[];
  /** Optional task template; placeholders {task} {context} are filled at run time. */
  task?: string;
}

/** A named, persisted team definition. */
export interface TeamDefinition {
  id: string;
  name: string;
  description: string;
  strategy: TeamStrategy;
  members: TeamMember[];
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Fields needed to create/update a team. */
export interface NewTeam {
  name: string;
  description?: string;
  strategy?: TeamStrategy;
  members: TeamMember[];
  options?: Record<string, unknown>;
}

export type TeamRunStatus = 'completed' | 'partial' | 'blocked' | 'error';

/** One member's delegated step within a run (success or graceful failure). */
export interface TeamRunStep {
  member: string;
  role: 'coordinator' | 'worker' | 'debater' | 'stage';
  task: string;
  output: string;
  status: 'completed' | 'stopped' | 'blocked' | 'error' | 'skipped';
  cost: number;
  runId?: string;
  error?: string;
}

/** A persisted record of one team run (definition, delegation trace, aggregation). */
export interface TeamRunRecord {
  id: string;
  teamId: string;
  teamName: string;
  task: string;
  strategy: TeamStrategy;
  status: TeamRunStatus;
  output: string;
  members: number;
  succeeded: number;
  failed: number;
  cost: number;
  trace: TeamRunStep[];
  error?: string;
  startedAt: string;
  endedAt: string;
  /** User who started the run (ownership for non-admin listing). */
  userId?: string;
}

/** Persistence port for team definitions + run records. */
export interface TeamStore {
  create(t: NewTeam): TeamDefinition;
  get(id: string): TeamDefinition | undefined;
  getByName(name: string): TeamDefinition | undefined;
  list(): TeamDefinition[];
  remove(id: string): boolean;

  recordRun(r: Omit<TeamRunRecord, 'id'>): TeamRunRecord;
  getRun(id: string): TeamRunRecord | undefined;
  /** List runs, optionally filtered by team and/or owning user. */
  listRuns(teamId?: string, limit?: number, userId?: string): TeamRunRecord[];
}

/** Input to delegate one member's subtask (the runtime wires this to the workflow spawner). */
export interface TeamDelegateInput {
  member: TeamMember;
  task: string;
  context?: string;
  principal: Principal;
  runId: string;
  depth: number;
  signal?: AbortSignal;
}

/** Result of one delegated member run. */
export interface TeamDelegateResult {
  output: string;
  cost: number;
  status: 'completed' | 'stopped' | 'blocked' | 'error';
  error?: string;
  runId?: string;
}

/** Delegates one member's subtask. Must not throw for a member-level failure — return status 'error'. */
export type TeamDelegate = (input: TeamDelegateInput) => Promise<TeamDelegateResult>;

/** Optional LLM used to synthesize/aggregate member outputs (coordinator synthesis, debate vote). */
export type TeamSynthesizer = (system: string, user: string) => Promise<string>;
