/**
 * Real, durable team store backed by the shared SQLite {@link Db} (tables `teams`, migration #14;
 * `team_runs`, migration #15). No mocks: {@link TeamsService} depends only on the {@link TeamStore}
 * port and this is the single concrete implementation used everywhere, including tests — mirroring
 * the persistence convention of the evals/bundles subsystems.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import type {
  NewTeam,
  TeamDefinition,
  TeamMember,
  TeamRunRecord,
  TeamRunStep,
  TeamStore,
  TeamStrategy,
} from './ports.js';

interface TeamRow {
  id: string;
  name: string;
  description: string;
  strategy: string;
  members: string;
  options: string;
  created_at: string;
  updated_at: string;
}

interface TeamRunRow {
  id: string;
  team_id: string;
  team_name: string;
  task: string;
  strategy: string;
  status: string;
  output: string;
  members: number;
  succeeded: number;
  failed: number;
  cost: number;
  trace: string;
  error: string | null;
  started_at: string;
  ended_at: string;
}

const toTeam = (r: TeamRow): TeamDefinition => ({
  id: r.id,
  name: r.name,
  description: r.description,
  strategy: r.strategy as TeamStrategy,
  members: fromJson<TeamMember[]>(r.members, []),
  options: fromJson<Record<string, unknown>>(r.options, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: TeamRunRow): TeamRunRecord => ({
  id: r.id,
  teamId: r.team_id,
  teamName: r.team_name,
  task: r.task,
  strategy: r.strategy as TeamStrategy,
  status: r.status as TeamRunRecord['status'],
  output: r.output,
  members: Number(r.members) || 0,
  succeeded: Number(r.succeeded) || 0,
  failed: Number(r.failed) || 0,
  cost: r.cost,
  trace: fromJson<TeamRunStep[]>(r.trace, []),
  error: r.error ?? undefined,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export class SqliteTeamStore implements TeamStore {
  constructor(private db: Db) {}

  create(t: NewTeam): TeamDefinition {
    const existing = this.getByName(t.name);
    const now = nowIso();
    if (existing) {
      // Upsert by name so re-creating a team updates it (idempotent definitions).
      this.db.run(
        'UPDATE teams SET description=?, strategy=?, members=?, options=?, updated_at=? WHERE id=?',
        t.description ?? '', t.strategy ?? 'coordinator', toJson(t.members), toJson(t.options ?? {}), now, existing.id,
      );
      return this.get(existing.id)!;
    }
    const id = newId('team');
    this.db.run(
      'INSERT INTO teams (id, name, description, strategy, members, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, t.name, t.description ?? '', t.strategy ?? 'coordinator', toJson(t.members), toJson(t.options ?? {}), now, now,
    );
    return this.get(id)!;
  }

  get(id: string): TeamDefinition | undefined {
    const r = this.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', id);
    return r ? toTeam(r) : undefined;
  }

  getByName(name: string): TeamDefinition | undefined {
    const r = this.db.get<TeamRow>('SELECT * FROM teams WHERE name = ?', name);
    return r ? toTeam(r) : undefined;
  }

  list(): TeamDefinition[] {
    return this.db.all<TeamRow>('SELECT * FROM teams ORDER BY created_at DESC').map(toTeam);
  }

  remove(id: string): boolean {
    this.db.run('DELETE FROM team_runs WHERE team_id = ?', id);
    return this.db.run('DELETE FROM teams WHERE id = ?', id).changes > 0;
  }

  recordRun(r: Omit<TeamRunRecord, 'id'>): TeamRunRecord {
    const id = newId('trun');
    this.db.run(
      `INSERT INTO team_runs (id, team_id, team_name, task, strategy, status, output, members, succeeded, failed, cost, trace, error, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, r.teamId, r.teamName, r.task, r.strategy, r.status, r.output, r.members, r.succeeded, r.failed, r.cost, toJson(r.trace), r.error ?? null, r.startedAt, r.endedAt,
    );
    return this.getRun(id)!;
  }

  getRun(id: string): TeamRunRecord | undefined {
    const r = this.db.get<TeamRunRow>('SELECT * FROM team_runs WHERE id = ?', id);
    return r ? toRun(r) : undefined;
  }

  listRuns(teamId?: string, limit = 100): TeamRunRecord[] {
    const rows = teamId
      ? this.db.all<TeamRunRow>('SELECT * FROM team_runs WHERE team_id = ? ORDER BY started_at DESC LIMIT ?', teamId, limit)
      : this.db.all<TeamRunRow>('SELECT * FROM team_runs ORDER BY started_at DESC LIMIT ?', limit);
    return rows.map(toRun);
  }
}
