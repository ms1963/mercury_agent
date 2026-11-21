/**
 * Self-distilling skills — data model + store port.
 *
 * A {@link DistilledSkill} is a reusable, parameterized procedure the agent distilled from a
 * winning run trace: the ordered tool-call sequence the successful run used, with concrete
 * arguments generalized into typed parameter slots, plus the natural-language intent it matches,
 * a version, a governance status and running outcome statistics.
 *
 * Persistence goes through the {@link SkillStore} port (real SQLite implementation in
 * `store.ts`); the {@link DistillerService} depends only on this interface, never on a concrete
 * database — mirroring the port/provider convention used elsewhere (voice, etc.). No mocks in
 * product code: the store is backed by the same persistent DB as every other subsystem.
 */

/** A typed parameter slot generalized from concrete tool-call arguments. */
export interface SkillParam {
  /** Slot name used in step argument templates as `{name}`. */
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  /** An example value observed in the source run (for docs / defaults). */
  example?: string;
}

/** One ordered step of the distilled procedure: a tool call with parameter slots in its args. */
export interface SkillStep {
  tool: string;
  /** Argument template; string values may contain `{param}` slots filled from matched inputs. */
  args: Record<string, unknown>;
}

export type SkillStatus = 'draft' | 'pending' | 'approved' | 'retired';

/** Running outcome statistics for a distilled skill (updated as it is reused). */
export interface DistilledSkillStats {
  uses: number;
  successes: number;
  failures: number;
  successRate: number;
  avgCost: number;
  avgTokens: number;
  lastUsed?: string;
}

export interface DistilledSkill {
  id: string;
  /** Stable kebab-case identifier (dedup key). */
  name: string;
  /** Natural-language intent this skill matches (the generalized task description). */
  trigger: string;
  params: SkillParam[];
  steps: SkillStep[];
  version: number;
  status: SkillStatus;
  /** Provenance — the run id(s) this skill was distilled/updated from (most recent first). */
  sourceRuns: string[];
  stats: DistilledSkillStats;
  createdAt: string;
  updatedAt: string;
}

/** Fields needed to create a brand-new distilled skill. */
export interface NewDistilledSkill {
  name: string;
  trigger: string;
  params: SkillParam[];
  steps: SkillStep[];
  status: SkillStatus;
  sourceRun?: string;
}

/**
 * Persistence port for distilled skills. A real, durable implementation is required
 * (`SqliteSkillStore`); this interface exists so the service is storage-agnostic and testable
 * against the same real store used in production.
 */
export interface SkillStore {
  insert(skill: NewDistilledSkill): DistilledSkill;
  get(id: string): DistilledSkill | undefined;
  getByName(name: string): DistilledSkill | undefined;
  list(status?: SkillStatus): DistilledSkill[];
  /** Persist an updated skill record (version/status/steps/params/stats/provenance). */
  save(skill: DistilledSkill): DistilledSkill;
  remove(id: string): boolean;
  /** Oldest retired skills beyond `keep` total records, for pruning. */
  pruneRetired(keep: number): number;
}
