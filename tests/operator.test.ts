/**
 * Offline, deterministic tests for the operator-conveniences pure logic (Tier-4 gap #20): completion
 * script generation, the logs read/format over an in-memory `runs` table, prompt-size component sizing,
 * and migration status/up against an in-memory Db. No real REPL/stdin is exercised.
 */
import { describe, it, expect } from 'vitest';
import {
  Db,
  MIGRATIONS,
  COMPLETION_SHELLS,
  OPERATOR_COMMANDS,
  generateCompletion,
  queryOperatorLogs,
  formatOperatorLogs,
  resolveOperatorLogRange,
  oneLine,
  computePromptSize,
  formatPromptSize,
  approxTokens,
  migrationStatus,
  queryAppliedMigrations,
  readMigrationStatus,
  applyPendingMigrations,
  operatorBanner,
  type CompletionShell,
} from '@mercury/core';

describe('completion — script generation', () => {
  for (const shell of COMPLETION_SHELLS) {
    it(`generates a non-empty ${shell} script mentioning real commands`, () => {
      const script = generateCompletion(shell as CompletionShell);
      expect(script.length).toBeGreaterThan(100);
      expect(script).toContain('mercury');
      // Real top-level commands appear in the script.
      expect(script).toContain('completion');
      expect(script).toContain('migrate');
      expect(script).toContain('sessions');
      // A subcommand of a command that has subs appears.
      expect(script).toContain('status');
    });
  }

  it('bash/zsh/fish scripts differ and carry shell-specific markers', () => {
    const bash = generateCompletion('bash');
    const zsh = generateCompletion('zsh');
    const fish = generateCompletion('fish');
    expect(bash).toContain('complete -F _mercury_completion mercury');
    expect(zsh).toContain('#compdef mercury');
    expect(fish).toContain('complete -c mercury');
    expect(bash).not.toBe(zsh);
    expect(zsh).not.toBe(fish);
  });

  it('every command in the spec has a name and the migrate command exposes status/up', () => {
    expect(OPERATOR_COMMANDS.length).toBeGreaterThan(20);
    const migrate = OPERATOR_COMMANDS.find((c) => c.name === 'migrate');
    expect(migrate?.subs).toEqual(['status', 'up']);
  });
});

describe('logs — read + format over the runs table', () => {
  const seed = (db: Db) => {
    const ins = (id: string, ts: string, kind: string, status: string, input: string) =>
      db.run(
        'INSERT INTO runs (id, user_id, session_id, kind, status, input, output, model, pattern, depth, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, 'u1', 's1', kind, status, input, 'ok', 'gpt-4o', 'react', 0, ts,
      );
    ins('r1', '2026-01-01T10:00:00.000Z', 'chat', 'ok', 'first request');
    ins('r2', '2026-01-02T10:00:00.000Z', 'chat', 'ok', 'second request');
    ins('r3', '2026-01-03T10:00:00.000Z', 'run', 'error', 'third request with a very long input '.repeat(5));
  };

  it('returns most-recent-first and respects the limit', () => {
    const db = new Db(':memory:');
    seed(db);
    const rows = queryOperatorLogs(db, { limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(['r3', 'r2']);
    expect(rows[0]!.status).toBe('error');
    db.close();
  });

  it('filters by since/until range', () => {
    const db = new Db(':memory:');
    seed(db);
    const rows = queryOperatorLogs(db, { sinceIso: '2026-01-02T00:00:00.000Z', untilIso: '2026-01-03T00:00:00.000Z' });
    expect(rows.map((r) => r.id)).toEqual(['r2']);
    db.close();
  });

  it('defaults the limit to 20 and clamps long summaries', () => {
    const db = new Db(':memory:');
    seed(db);
    const rows = queryOperatorLogs(db);
    expect(rows.length).toBe(3);
    const long = rows.find((r) => r.id === 'r3')!;
    expect(long.summary.length).toBeLessThanOrEqual(60);
    db.close();
  });

  it('formats a readable table and handles the empty case', () => {
    expect(formatOperatorLogs([])).toBe('no activity recorded');
    const db = new Db(':memory:');
    seed(db);
    const table = formatOperatorLogs(queryOperatorLogs(db));
    expect(table).toContain('TIME');
    expect(table).toContain('STATUS');
    expect(table).toContain('first request');
    db.close();
  });

  it('resolveOperatorLogRange converts durations with a fixed clock', () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const { sinceIso } = resolveOperatorLogRange({ since: '1d' }, now);
    expect(sinceIso).toBe('2026-01-31T00:00:00.000Z');
    expect(resolveOperatorLogRange({}, now)).toEqual({});
  });

  it('oneLine collapses whitespace and truncates', () => {
    expect(oneLine('  a   b\nc  ')).toBe('a b c');
    expect(oneLine('x'.repeat(100), 10)).toHaveLength(10);
    expect(oneLine(undefined)).toBe('');
  });
});

describe('prompt-size — component sizing', () => {
  it('approxTokens is ~4 chars/token, rounded up', () => {
    expect(approxTokens(0)).toBe(0);
    expect(approxTokens(4)).toBe(1);
    expect(approxTokens(5)).toBe(2);
  });

  it('sums component chars and tokens and keeps empty components at 0', () => {
    const r = computePromptSize([
      { name: 'persona', text: 'abcd' },
      { name: 'rules', text: 'abcdefgh' },
      { name: 'memory', text: '' },
    ]);
    expect(r.components).toHaveLength(3);
    expect(r.components[0]).toEqual({ name: 'persona', chars: 4, tokens: 1 });
    expect(r.components[2]).toEqual({ name: 'memory', chars: 0, tokens: 0 });
    expect(r.totalChars).toBe(12);
    expect(r.totalTokens).toBe(3);
    expect(r.approximate).toBe(true);
  });

  it('formats a table with a TOTAL row', () => {
    const table = formatPromptSize(computePromptSize([{ name: 'persona', text: 'hi' }]));
    expect(table).toContain('COMPONENT');
    expect(table).toContain('TOTAL');
    expect(table).toContain('persona');
  });
});

describe('migrate — status/up against an in-memory Db', () => {
  it('migrationStatus computes applied/pending/current purely', () => {
    const s = migrationStatus([1, 2, 3], 5);
    expect(s.applied).toEqual([1, 2, 3]);
    expect(s.pending).toEqual([4, 5]);
    expect(s.current).toBe(3);
    expect(s.upToDate).toBe(false);
    expect(migrationStatus([1, 2], 2).upToDate).toBe(true);
    expect(migrationStatus([], 2).current).toBe(0);
  });

  it('a fresh in-memory Db is fully migrated at construction', () => {
    const db = new Db(':memory:');
    const applied = queryAppliedMigrations(db);
    expect(applied).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    const status = readMigrationStatus(db);
    expect(status.total).toBe(MIGRATIONS.length);
    expect(status.pending).toEqual([]);
    expect(status.upToDate).toBe(true);
    db.close();
  });

  it('applyPendingMigrations is a no-op on an already-migrated Db (boot already applied them)', () => {
    // new Db() runs migrations at construction, so nothing is pending and this confirms up-to-date.
    const db = new Db(':memory:');
    expect(applyPendingMigrations(db)).toEqual([]);
    expect(readMigrationStatus(db).upToDate).toBe(true);
    db.close();
  });
});

describe('console — operator banner (pure)', () => {
  it('renders all the operator fields', () => {
    const banner = operatorBanner({
      version: '1.9.0',
      dbPath: '/tmp/m.db',
      dataDir: '/home/op/.mercury',
      model: 'openrouter/gpt-4o-mini',
      personality: 'default',
      pattern: 'react',
      user: 'operator',
    });
    expect(banner).toContain('v1.9.0');
    expect(banner).toContain('/tmp/m.db');
    expect(banner).toContain('/home/op/.mercury');
    expect(banner).toContain('openrouter/gpt-4o-mini');
    expect(banner).toContain('operator');
    expect(banner).toContain('pattern: react');
  });

  it('omits the pattern label when none is given', () => {
    const banner = operatorBanner({
      version: '1.9.0', dbPath: ':memory:', dataDir: '(default)', model: 'm', personality: 'default', user: 'op',
    });
    expect(banner).not.toContain('pattern:');
  });
});
