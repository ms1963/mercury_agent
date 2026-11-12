/**
 * Thin SQLite wrapper. Uses the built-in `node:sqlite` (Node >= 22.5, FTS5 included).
 * All persistence in Mercury goes through this small interface, so swapping the
 * driver (e.g. better-sqlite3 or Postgres) only touches this file.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

type Param = string | number | bigint | null | Uint8Array;
export type SqlValue = Param | boolean | undefined;

interface Statement {
  run(...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function openRaw(file: string): RawDb {
  // Silence the one-time ExperimentalWarning printed by node:sqlite.
  const original = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(w).includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => RawDb };
    return new DatabaseSync(file);
  } catch (err) {
    throw new Error(`Mercury requires Node.js >= 22.5 with node:sqlite (FTS5). (${String(err)})`);
  } finally {
    process.emitWarning = original;
  }
}

const norm = (params: SqlValue[]): Param[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export class Db {
  private raw: RawDb;
  private cache = new Map<string, Statement>();

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = openRaw(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.raw.prepare(sql)));
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return (this.stmt(sql).get(...norm(params)) as T | undefined) ?? undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...norm(params)) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    const row = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
    const current = row?.v ?? 0;
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (version <= current) return;
      this.transaction(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, new Date().toISOString());
      });
    });
  }
}

/** Helpers for JSON columns. */
export const toJson = (v: unknown): string => JSON.stringify(v ?? null);
export function fromJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return (JSON.parse(v) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Escape user text for an FTS5 MATCH query (each word quoted, OR-joined). */
export function ftsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  return words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}
