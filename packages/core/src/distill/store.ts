/**
 * Real, durable {@link SkillStore} implementation backed by the shared SQLite {@link Db}
 * (table `distilled_skills`, migration #7). No mocks: the distiller depends only on the
 * {@link SkillStore} port, and this is the single concrete implementation used everywhere,
 * including tests — mirroring the persistence convention of the learning/reliability subsystems.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import type {
  DistilledSkill,
  NewDistilledSkill,
  SkillParam,
  SkillStatus,
  SkillStep,
  SkillStore,
} from './ports.js';

interface SkillRow {
  id: string;
  name: string;
  trigger: string;
  params: string;
  steps: string;
  version: number;
  status: string;
  source_runs: string;
  uses: number;
  successes: number;
  failures: number;
  cost_sum: number;
  tokens_sum: number;
  last_used: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSkill(r: SkillRow): DistilledSkill {
  const uses = Number(r.uses) || 0;
  const successes = Number(r.successes) || 0;
  const failures = Number(r.failures) || 0;
  const costSum = Number(r.cost_sum) || 0;
  const tokensSum = Number(r.tokens_sum) || 0;
  const denom = successes + failures;
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    params: fromJson<SkillParam[]>(r.params, []),
    steps: fromJson<SkillStep[]>(r.steps, []),
    version: Number(r.version) || 1,
    status: r.status as SkillStatus,
    sourceRuns: fromJson<string[]>(r.source_runs, []),
    stats: {
      uses,
      successes,
      failures,
      successRate: denom > 0 ? Math.round((successes / denom) * 1e4) / 1e4 : 0,
      avgCost: uses > 0 ? Math.round((costSum / uses) * 1e6) / 1e6 : 0,
      avgTokens: uses > 0 ? Math.round(tokensSum / uses) : 0,
      lastUsed: r.last_used ?? undefined,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqliteSkillStore implements SkillStore {
  constructor(private db: Db) {}

  insert(skill: NewDistilledSkill): DistilledSkill {
    const now = nowIso();
    const id = newId('skill');
    const sourceRuns = skill.sourceRun ? [skill.sourceRun] : [];
    this.db.run(
      `INSERT INTO distilled_skills
         (id, name, trigger, params, steps, version, status, source_runs,
          uses, successes, failures, cost_sum, tokens_sum, last_used, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,0,0,0,0,NULL,?,?)`,
      id,
      skill.name,
      skill.trigger,
      toJson(skill.params),
      toJson(skill.steps),
      1,
      skill.status,
      toJson(sourceRuns),
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): DistilledSkill | undefined {
    const r = this.db.get<SkillRow>('SELECT * FROM distilled_skills WHERE id = ?', id);
    return r ? rowToSkill(r) : undefined;
  }

  getByName(name: string): DistilledSkill | undefined {
    const r = this.db.get<SkillRow>('SELECT * FROM distilled_skills WHERE name = ?', name);
    return r ? rowToSkill(r) : undefined;
  }

  list(status?: SkillStatus): DistilledSkill[] {
    const rows = status
      ? this.db.all<SkillRow>('SELECT * FROM distilled_skills WHERE status = ? ORDER BY updated_at DESC', status)
      : this.db.all<SkillRow>('SELECT * FROM distilled_skills ORDER BY updated_at DESC');
    return rows.map(rowToSkill);
  }

  save(skill: DistilledSkill): DistilledSkill {
    const now = nowIso();
    this.db.run(
      `UPDATE distilled_skills SET
         name = ?, trigger = ?, params = ?, steps = ?, version = ?, status = ?, source_runs = ?,
         uses = ?, successes = ?, failures = ?, cost_sum = ?, tokens_sum = ?, last_used = ?, updated_at = ?
       WHERE id = ?`,
      skill.name,
      skill.trigger,
      toJson(skill.params),
      toJson(skill.steps),
      skill.version,
      skill.status,
      toJson(skill.sourceRuns),
      skill.stats.uses,
      skill.stats.successes,
      skill.stats.failures,
      // Persist the running sums so averages survive reload (derive from avg*uses).
      Math.round(skill.stats.avgCost * skill.stats.uses * 1e6) / 1e6,
      Math.round(skill.stats.avgTokens * skill.stats.uses),
      skill.stats.lastUsed ?? null,
      now,
      skill.id,
    );
    return this.get(skill.id)!;
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM distilled_skills WHERE id = ?', id).changes > 0;
  }

  pruneRetired(keep: number): number {
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM distilled_skills')?.n ?? 0;
    const excess = total - keep;
    if (excess <= 0) return 0;
    // Prune oldest retired skills first (never touches approved/pending skills).
    const victims = this.db.all<{ id: string }>(
      "SELECT id FROM distilled_skills WHERE status = 'retired' ORDER BY updated_at ASC LIMIT ?",
      excess,
    );
    let removed = 0;
    for (const v of victims) removed += this.remove(v.id) ? 1 : 0;
    return removed;
  }
}
