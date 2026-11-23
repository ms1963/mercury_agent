import { describe, it, expect } from 'vitest';
import { Db, SqliteTeamStore, TeamsService, ConfigSchema, SYSTEM_PRINCIPAL } from '@mercury/core';
import type { TeamDelegate } from '@mercury/core';

function svc(delegate: TeamDelegate, overrides: Record<string, unknown> = {}) {
  const db = new Db(':memory:');
  const config = ConfigSchema.parse({ teams: { enabled: true, ...overrides } });
  const store = new SqliteTeamStore(db);
  return { service: new TeamsService(store, config, { delegate }), db };
}

const okDelegate: TeamDelegate = async (input) => ({ output: `done:${input.member.name}:${input.task.slice(0, 20)}`, cost: 1, status: 'completed' });

describe('teams orchestration', () => {
  it('creates, lists, gets and deletes teams (persisted)', () => {
    const { service } = svc(okDelegate);
    const def = service.define(SYSTEM_PRINCIPAL, { name: 'squad', members: [{ name: 'alice', role: 'coordinator' }, { name: 'bob', role: 'worker' }] });
    expect(def.name).toBe('squad');
    expect(service.list().length).toBe(1);
    expect(service.get('squad')?.id).toBe(def.id);
    expect(service.delete(SYSTEM_PRINCIPAL, 'squad')).toBe(true);
    expect(service.list().length).toBe(0);
  });

  it('runs a coordinator team and aggregates worker output', async () => {
    const { service } = svc(okDelegate);
    service.define(SYSTEM_PRINCIPAL, { name: 'squad', strategy: 'coordinator', members: [{ name: 'lead', role: 'coordinator' }, { name: 'w1', role: 'worker' }, { name: 'w2', role: 'worker' }] });
    const rec = await service.run(SYSTEM_PRINCIPAL, 'squad', 'build a thing');
    expect(rec.status).toBe('completed');
    expect(rec.trace.length).toBeGreaterThan(0);
    expect(service.getRun(rec.id)?.id).toBe(rec.id);
  });

  it('degrades gracefully when a member fails (does not crash the run)', async () => {
    const flaky: TeamDelegate = async (input) => {
      if (input.member.name === 'bad') throw new Error('boom');
      return { output: `ok:${input.member.name}`, cost: 1, status: 'completed' };
    };
    const { service } = svc(flaky);
    service.define(SYSTEM_PRINCIPAL, { name: 'squad', strategy: 'pipeline', members: [{ name: 'good', role: 'worker' }, { name: 'bad', role: 'worker' }] });
    const rec = await service.run(SYSTEM_PRINCIPAL, 'squad', 'go');
    expect(['partial', 'completed', 'error']).toContain(rec.status);
    expect(rec.failed).toBeGreaterThanOrEqual(1);
    const bad = rec.trace.find((s) => s.member === 'bad');
    expect(bad?.status).toBe('error');
  });

  it('enforces a per-run budget ceiling', async () => {
    const { service } = svc(async (_i) => ({ output: 'x', cost: 10, status: 'completed' }));
    service.define(SYSTEM_PRINCIPAL, { name: 'squad', strategy: 'pipeline', members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const rec = await service.run(SYSTEM_PRINCIPAL, 'squad', 'go', { budget: 12 });
    expect(rec.cost).toBeLessThanOrEqual(20);
    expect(rec.trace.some((s) => s.status === 'skipped')).toBe(true);
  });

  it('refuses to run when teams are disabled', async () => {
    const { service: _service } = svc(okDelegate, {});
    const dbConfig = ConfigSchema.parse({ teams: { enabled: false } });
    const db = new Db(':memory:');
    const s2 = new TeamsService(new SqliteTeamStore(db), dbConfig, { delegate: okDelegate });
    await expect(s2.run(SYSTEM_PRINCIPAL, 'nope', 'go')).rejects.toBeTruthy();
  });
});
