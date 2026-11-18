/** Persistent (SQLite-backed) rate limiter: limit enforcement, window expiry, cross-restart persistence. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, RateLimiter } from '@mercury/core';

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-rl-'));
  dbFile = join(dir, 'mercury.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('persistent rate limiter', () => {
  it('enforces the configured limit within a window', () => {
    const db = new Db(dbFile);
    const rl = new RateLimiter(db, 3, 60_000);
    const now = 1_000_000;
    expect(rl.hit('ip-a', now)).toBe(true); // 1
    expect(rl.hit('ip-a', now + 1)).toBe(true); // 2
    expect(rl.hit('ip-a', now + 2)).toBe(true); // 3
    expect(rl.hit('ip-a', now + 3)).toBe(false); // 4 → blocked
    expect(rl.hit('ip-a', now + 4)).toBe(false); // still blocked
    db.close();
  });

  it('isolates counters per key (bucket)', () => {
    const db = new Db(dbFile);
    const rl = new RateLimiter(db, 2, 60_000);
    const now = 2_000_000;
    expect(rl.hit('ip-a', now)).toBe(true);
    expect(rl.hit('ip-a', now + 1)).toBe(true);
    expect(rl.hit('ip-a', now + 2)).toBe(false); // ip-a exhausted
    expect(rl.hit('ip-b', now + 3)).toBe(true); // ip-b independent
    expect(rl.hit('ip-b', now + 4)).toBe(true);
    expect(rl.hit('ip-b', now + 5)).toBe(false);
    db.close();
  });

  it('resets after the window expires', () => {
    const db = new Db(dbFile);
    const rl = new RateLimiter(db, 2, 1_000);
    const now = 3_000_000;
    expect(rl.hit('ip-a', now)).toBe(true);
    expect(rl.hit('ip-a', now + 10)).toBe(true);
    expect(rl.hit('ip-a', now + 20)).toBe(false); // blocked within window
    // Advance past the window → new window, counter resets.
    expect(rl.hit('ip-a', now + 1_000)).toBe(true);
    expect(rl.hit('ip-a', now + 1_010)).toBe(true);
    expect(rl.hit('ip-a', now + 1_020)).toBe(false);
    db.close();
  });

  it('persists counters across a process/DB restart (reopen same file)', () => {
    const now = 4_000_000;
    // First "process": exhaust the limit, then close the DB.
    const db1 = new Db(dbFile);
    const rl1 = new RateLimiter(db1, 3, 60_000);
    expect(rl1.hit('ip-a', now)).toBe(true);
    expect(rl1.hit('ip-a', now + 1)).toBe(true);
    expect(rl1.hit('ip-a', now + 2)).toBe(true);
    db1.close();

    // Second "process": reopen the same DB file — the counter must survive.
    const db2 = new Db(dbFile);
    const rl2 = new RateLimiter(db2, 3, 60_000);
    expect(rl2.hit('ip-a', now + 3)).toBe(false); // 4th hit, still within window → blocked
    // After the window elapses it resets even across the restart.
    expect(rl2.hit('ip-a', now + 60_000)).toBe(true);
    db2.close();
  });

  it('shares counters across multiple limiter instances over the same DB (single-process-shared)', () => {
    const db = new Db(dbFile);
    const a = new RateLimiter(db, 2, 60_000);
    const b = new RateLimiter(db, 2, 60_000);
    const now = 5_000_000;
    expect(a.hit('ip-a', now)).toBe(true);
    expect(b.hit('ip-a', now + 1)).toBe(true);
    expect(a.hit('ip-a', now + 2)).toBe(false); // combined count exceeds max
    db.close();
  });
});
