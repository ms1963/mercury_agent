/**
 * Tests for the session-management surface (`mercury sessions list|rename|export|delete|prune`).
 *
 * SCOPE: fully offline and deterministic. No network, no LLM, no running Mercury. The PURE selection /
 * filtering / export logic is exercised in-memory with an injected clock and plain fixtures; the storage
 * integration (listAll / updateSession / deleteSession / messages) is exercised against a real
 * `:memory:` SQLite `Db` + `EpisodicStore`, which is the same store the CLI uses.
 *
 * Covers: prune-selection (older-than with an injected clock; keep-N; empty-only; combinations; safe
 * no-op; dry-run returns the selection without deleting); cutoff parsing (durations + ISO + errors);
 * list sort/search/limit; find-by-prefix (exact, unique, ambiguous, missing); rename updates the right
 * record; export shaping (JSON + markdown); delete removes the right record and cascades messages.
 */
import { describe, it, expect } from 'vitest';
import {
  Db,
  EpisodicStore,
  buildSessionExport,
  filterSessions,
  findSession,
  parseCutoff,
  recencyOf,
  renderSessionMarkdown,
  selectPrune,
  sortByRecent,
  workingDirOf,
  type Session,
} from '@mercury/core';

// ──────────────────────────── fixtures (pure, no DB) ────────────────────────────

const ISO = (s: string): string => new Date(s).toISOString();

function mk(id: string, updatedAt: string, opts: Partial<Session> = {}): Session {
  return {
    id,
    userId: 'u1',
    title: opts.title ?? `Session ${id}`,
    model: opts.model,
    platform: opts.platform,
    personality: opts.personality,
    meta: opts.meta ?? {},
    createdAt: opts.createdAt ?? updatedAt,
    updatedAt,
    messageCount: opts.messageCount ?? 2,
  };
}

// Oldest → newest; sorting should reverse this.
const SESSIONS = (): Session[] => [
  mk('ses_aaa', ISO('2026-01-01T00:00:00Z'), { title: 'Alpha planning', messageCount: 0 }),
  mk('ses_bbb', ISO('2026-01-10T00:00:00Z'), { title: 'Beta research', messageCount: 5 }),
  mk('ses_ccc', ISO('2026-02-01T00:00:00Z'), { title: 'Gamma alpha notes', messageCount: 0 }),
  mk('ses_ddd', ISO('2026-03-01T00:00:00Z'), { title: 'Delta review', messageCount: 3 }),
];

const NOW = new Date('2026-03-15T00:00:00Z');

// ──────────────────────────── sort + filter ────────────────────────────

describe('sortByRecent / filterSessions', () => {
  it('sorts most-recent-first (by updatedAt)', () => {
    const ids = sortByRecent(SESSIONS()).map((s) => s.id);
    expect(ids).toEqual(['ses_ddd', 'ses_ccc', 'ses_bbb', 'ses_aaa']);
  });

  it('is deterministic for equal timestamps (createdAt then id tie-break)', () => {
    const t = ISO('2026-01-01T00:00:00Z');
    const list = [mk('ses_z', t), mk('ses_a', t), mk('ses_m', t)];
    expect(sortByRecent(list).map((s) => s.id)).toEqual(['ses_z', 'ses_m', 'ses_a']);
  });

  it('search filters by title (case-insensitive substring)', () => {
    const ids = filterSessions(SESSIONS(), { search: 'alpha' }).map((s) => s.id);
    // 'Alpha planning' and 'Gamma alpha notes', still most-recent-first
    expect(ids).toEqual(['ses_ccc', 'ses_aaa']);
  });

  it('limit truncates after sorting + search', () => {
    expect(filterSessions(SESSIONS(), { limit: 2 }).map((s) => s.id)).toEqual(['ses_ddd', 'ses_ccc']);
    expect(filterSessions(SESSIONS(), { limit: 0 })).toEqual([]);
  });

  it('recencyOf falls back to createdAt when updatedAt is empty', () => {
    expect(recencyOf({ ...mk('x', ''), updatedAt: '', createdAt: ISO('2026-01-01T00:00:00Z') })).toBe(ISO('2026-01-01T00:00:00Z'));
  });

  it('workingDirOf reads cwd/workingDir/dir from meta only', () => {
    expect(workingDirOf(mk('x', ISO('2026-01-01T00:00:00Z'), { meta: { cwd: '/home/u/proj' } }))).toBe('/home/u/proj');
    expect(workingDirOf(mk('x', ISO('2026-01-01T00:00:00Z'), { meta: {} }))).toBeUndefined();
  });
});

// ──────────────────────────── find-by-id/prefix ────────────────────────────

describe('findSession', () => {
  it('resolves an exact id', () => {
    expect((findSession(SESSIONS(), 'ses_bbb') as Session).id).toBe('ses_bbb');
  });
  it('resolves a unique prefix', () => {
    expect((findSession(SESSIONS(), 'ses_d') as Session).id).toBe('ses_ddd');
  });
  it('reports ambiguous for a non-unique prefix', () => {
    expect(findSession(SESSIONS(), 'ses_')).toBe('ambiguous');
  });
  it('returns undefined for no match', () => {
    expect(findSession(SESSIONS(), 'nope')).toBeUndefined();
  });
});

// ──────────────────────────── parseCutoff ────────────────────────────

describe('parseCutoff', () => {
  it('parses durations relative to the injected clock', () => {
    expect(parseCutoff('30d', NOW).toISOString()).toBe(new Date('2026-02-13T00:00:00Z').toISOString());
    expect(parseCutoff('12h', NOW).toISOString()).toBe(new Date('2026-03-14T12:00:00Z').toISOString());
    expect(parseCutoff('2w', NOW).toISOString()).toBe(new Date('2026-03-01T00:00:00Z').toISOString());
    expect(parseCutoff('90m', NOW).toISOString()).toBe(new Date('2026-03-14T22:30:00Z').toISOString());
  });
  it('parses an absolute ISO date', () => {
    expect(parseCutoff('2026-02-01', NOW).getTime()).toBe(new Date('2026-02-01').getTime());
  });
  it('throws on garbage', () => {
    expect(() => parseCutoff('soon', NOW)).toThrow(/invalid --older-than/);
  });
});

// ──────────────────────────── selectPrune (pure, injected clock) ────────────────────────────

describe('selectPrune', () => {
  it('older-than selects sessions before the cutoff', () => {
    // cutoff = 2026-02-13 → aaa(Jan01), bbb(Jan10), ccc(Feb01) are older; ddd(Mar01) is not.
    const sel = selectPrune(SESSIONS(), { olderThan: '30d' }, NOW);
    expect(sel.toDelete.map((d) => d.session.id).sort()).toEqual(['ses_aaa', 'ses_bbb', 'ses_ccc']);
    expect(sel.kept.map((s) => s.id)).toEqual(['ses_ddd']);
    for (const d of sel.toDelete) expect(d.reasons[0]).toMatch(/older than/);
  });

  it('keep-N protects the most-recent N and selects the rest when no other criterion', () => {
    const sel = selectPrune(SESSIONS(), { keep: 2 }, NOW);
    expect(sel.kept.map((s) => s.id)).toEqual(['ses_ddd', 'ses_ccc']);
    expect(sel.toDelete.map((d) => d.session.id)).toEqual(['ses_bbb', 'ses_aaa']);
    expect(sel.toDelete[0]!.reasons[0]).toMatch(/beyond keep=2/);
  });

  it('empty-only selects zero-message sessions', () => {
    const sel = selectPrune(SESSIONS(), { empty: true }, NOW);
    expect(sel.toDelete.map((d) => d.session.id).sort()).toEqual(['ses_aaa', 'ses_ccc']);
    for (const d of sel.toDelete) expect(d.reasons).toContain('empty (0 messages)');
  });

  it('combines older-than + keep: keep always protects the top N', () => {
    // older-than 30d would take aaa,bbb,ccc; keep=3 protects ddd,ccc,bbb → only aaa deleted.
    const sel = selectPrune(SESSIONS(), { olderThan: '30d', keep: 3 }, NOW);
    expect(sel.toDelete.map((d) => d.session.id)).toEqual(['ses_aaa']);
  });

  it('combines empty + older-than as a union of reasons', () => {
    const sel = selectPrune(SESSIONS(), { empty: true, olderThan: '30d' }, NOW);
    // aaa (empty + old), bbb (old), ccc (empty + old)
    expect(sel.toDelete.map((d) => d.session.id).sort()).toEqual(['ses_aaa', 'ses_bbb', 'ses_ccc']);
    const aaa = sel.toDelete.find((d) => d.session.id === 'ses_aaa')!;
    expect(aaa.reasons.length).toBe(2);
  });

  it('is a safe no-op with no options', () => {
    const sel = selectPrune(SESSIONS(), {}, NOW);
    expect(sel.toDelete).toEqual([]);
    expect(sel.kept.length).toBe(4);
  });

  it('dry-run semantics: selection is pure and mutates nothing', () => {
    const list = SESSIONS();
    const before = JSON.stringify(list);
    selectPrune(list, { olderThan: '30d', keep: 1, empty: true }, NOW);
    expect(JSON.stringify(list)).toBe(before);
  });
});

// ──────────────────────────── export shaping ────────────────────────────

const MSGS = () => [
  { id: 'm1', seq: 1, role: 'user' as const, content: 'Hello', createdAt: ISO('2026-01-01T00:00:00Z') },
  { id: 'm2', seq: 2, role: 'assistant' as const, content: 'Hi there', createdAt: ISO('2026-01-01T00:01:00Z') },
];

describe('export shaping', () => {
  it('buildSessionExport wraps session + messages with a format version', () => {
    const s = mk('ses_bbb', ISO('2026-01-10T00:00:00Z'), { model: 'gpt-test' });
    const doc = buildSessionExport(s, MSGS());
    expect(doc.formatVersion).toBe(1);
    expect(doc.session.id).toBe('ses_bbb');
    expect(doc.messageCount).toBe(2);
    expect(doc.messages).toHaveLength(2);
  });

  it('renderSessionMarkdown emits a deterministic transcript', () => {
    const s = mk('ses_bbb', ISO('2026-01-10T00:00:00Z'), { title: 'Beta', model: 'gpt-test', meta: { cwd: '/w' } });
    const md = renderSessionMarkdown(s, MSGS());
    expect(md).toContain('# Beta');
    expect(md).toContain('**Session:** ses_bbb');
    expect(md).toContain('**Model:** gpt-test');
    expect(md).toContain('**Working dir:** /w');
    expect(md).toContain('### user');
    expect(md).toContain('Hello');
    expect(md).toContain('### assistant');
    expect(md).toContain('Hi there');
  });

  it('markdown shows a placeholder for empty content', () => {
    const s = mk('ses_e', ISO('2026-01-10T00:00:00Z'));
    const md = renderSessionMarkdown(s, [{ id: 'm', seq: 1, role: 'user', content: '', createdAt: ISO('2026-01-10T00:00:00Z') }]);
    expect(md).toContain('_(no content)_');
  });
});

// ──────────────────────────── storage integration (:memory: DB) ────────────────────────────

describe('EpisodicStore management ops (real :memory: DB)', () => {
  function seed(): { store: EpisodicStore; ids: string[] } {
    const db = new Db(':memory:');
    const store = new EpisodicStore(db);
    const a = store.createSession('u1', { title: 'first', model: 'm1' });
    const b = store.createSession('u1', { title: 'second' });
    const c = store.createSession('u2', { title: 'third (other user)' });
    store.append(b.id, 'u1', { role: 'user', content: 'hi' });
    store.append(b.id, 'u1', { role: 'assistant', content: 'hello' });
    return { store, ids: [a.id, b.id, c.id] };
  }

  it('listAll returns every session across users with message counts', () => {
    const { store, ids } = seed();
    const all = store.listAll();
    expect(all.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(all.find((s) => s.title === 'second')!.messageCount).toBe(2);
    expect(all.find((s) => s.title === 'first')!.messageCount).toBe(0);
  });

  it('rename via updateSession updates only the target record', () => {
    const { store, ids } = seed();
    const updated = store.updateSession(ids[0]!, { title: 'renamed!' });
    expect(updated!.title).toBe('renamed!');
    expect(store.getSession(ids[1]!)!.title).toBe('second');
  });

  it('delete removes the target and cascades its messages', () => {
    const { store, ids } = seed();
    expect(store.messages(ids[1]!).length).toBe(2);
    store.deleteSession(ids[1]!);
    expect(store.getSession(ids[1]!)).toBeUndefined();
    expect(store.messages(ids[1]!).length).toBe(0);
    // other sessions untouched
    expect(store.getSession(ids[0]!)).toBeDefined();
    expect(store.getSession(ids[2]!)).toBeDefined();
  });

  it('end-to-end prune against the real store deletes exactly the selection', () => {
    const { store, ids } = seed();
    // keep=1 protects the most-recently-updated (b, which was appended to last), deletes the other two.
    const all = store.listAll();
    const sel = selectPrune(all, { keep: 1 }, NOW);
    for (const d of sel.toDelete) store.deleteSession(d.session.id);
    const remaining = store.listAll().map((s) => s.id);
    expect(remaining).toHaveLength(1);
    expect(sel.toDelete.map((d) => d.session.id)).not.toContain(remaining[0]);
    expect(ids.length).toBe(3);
  });

  it('export reads messages for a real session', () => {
    const { store, ids } = seed();
    const s = store.getSession(ids[1]!)!;
    const doc = buildSessionExport(s, store.messages(s.id));
    expect(doc.messages.map((m) => m.content)).toEqual(['hi', 'hello']);
  });
});
