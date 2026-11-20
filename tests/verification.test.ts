/**
 * Feature — Built-in verification (evidence-based completion).
 *
 * Covers the JSON-shape validator, the four check runners with REAL side effects (test runs a
 * real process, assertion hits a real filesystem / a real local HTTP server), the Verifier's
 * weighted-confidence aggregation, escalation + persistence, and the end-to-end critic wired
 * through a real Mercury instance's decision engine.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  EventBus,
  Verifier,
  defaultAssertionRegistry,
  runCheck,
  validateShape,
  type Check,
  type CriticFn,
} from '@mercury/core';
import { makeMercury } from './helpers.js';

const cfg = (overrides: Record<string, unknown> = {}) => ConfigSchema.parse(overrides);
const assertions = defaultAssertionRegistry();

describe('validateShape', () => {
  it('accepts a conforming object and reports violations otherwise', () => {
    const shape = { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer', minimum: 0 } } } as const;
    expect(validateShape({ name: 'a', age: 3 }, shape)).toEqual([]);
    expect(validateShape({ name: '', age: -1 }, shape).length).toBe(2);
    expect(validateShape({ age: 3 }, shape)[0]).toMatch(/name: required/);
  });

  it('checks enums, arrays, nullability and type mismatches', () => {
    expect(validateShape('b', { type: 'string', enum: ['a', 'b'] })).toEqual([]);
    expect(validateShape('c', { type: 'string', enum: ['a', 'b'] }).length).toBe(1);
    expect(validateShape([1, 2], { type: 'array', items: { type: 'integer' } })).toEqual([]);
    expect(validateShape([1, 'x'], { type: 'array', items: { type: 'integer' } }).length).toBe(1);
    expect(validateShape(null, { type: 'string', nullable: true })).toEqual([]);
    expect(validateShape(5, { type: 'string' }).length).toBe(1);
  });
});

describe('runCheck — test (real process)', () => {
  it('passes on exit 0 and fails on non-zero', async () => {
    const ok = await runCheck({ type: 'test', command: 'node -e "process.exit(0)"' } as Check, {}, { assertions });
    expect(ok.passed).toBe(true);
    expect(ok.score).toBe(1);
    const bad = await runCheck({ type: 'test', command: 'node -e "process.exit(2)"', required: true } as Check, {}, { assertions });
    expect(bad.passed).toBe(false);
    expect(bad.detail).toMatch(/exit 2/);
  });

  it('enforces an expected substring in output', async () => {
    const ok = await runCheck({ type: 'test', command: 'node -e "console.log(42)"', expect: '42' } as Check, {}, { assertions });
    expect(ok.passed).toBe(true);
    const miss = await runCheck({ type: 'test', command: 'node -e "console.log(42)"', expect: 'nope' } as Check, {}, { assertions });
    expect(miss.passed).toBe(false);
  });
});

describe('runCheck — schema / critic / assertion', () => {
  it('schema check validates the result (optionally at a path)', async () => {
    const r = await runCheck({ type: 'schema', path: 'user', schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } as Check, { result: { user: { id: 1 } } }, { assertions });
    expect(r.passed).toBe(true);
    const bad = await runCheck({ type: 'schema', schema: { type: 'object', required: ['id'] } } as Check, { result: {} }, { assertions });
    expect(bad.passed).toBe(false);
  });

  it('critic check scores via the injected critic (confidence → score)', async () => {
    const critic: CriticFn = async (goal, output) => ({ passed: output.includes('done'), confidence: output.includes('done') ? 0.9 : 0.2, detail: 'judged' });
    const pass = await runCheck({ type: 'critic', goal: 'finish it' } as Check, { output: 'all done' }, { critic, assertions });
    expect(pass.passed).toBe(true);
    expect(pass.score).toBeCloseTo(0.9);
    const fail = await runCheck({ type: 'critic', goal: 'finish it' } as Check, { output: 'not yet' }, { critic, assertions });
    expect(fail.passed).toBe(false);
    const none = await runCheck({ type: 'critic' } as Check, { output: 'x' }, { assertions });
    expect(none.detail).toMatch(/no critic/);
  });

  it('file_exists assertion hits the real filesystem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-fs-'));
    const f = join(dir, 'artifact.txt');
    writeFileSync(f, 'hello');
    try {
      const ok = await runCheck({ type: 'assertion', checker: 'file_exists', params: { path: f, minBytes: 1 } } as Check, {}, { assertions });
      expect(ok.passed).toBe(true);
      expect(ok.detail).toMatch(/exists/);
      const missing = await runCheck({ type: 'assertion', checker: 'file_exists', params: { path: join(dir, 'nope') } } as Check, {}, { assertions });
      expect(missing.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unknown assertion checker', async () => {
    const r = await runCheck({ type: 'assertion', checker: 'ghost' } as Check, {}, { assertions });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/unknown assertion/);
  });
});

describe('http assertion (real local server)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); res.end('pong'); } else { res.writeHead(500); res.end('boom'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('passes on a real 200 with expected body and fails on 500', async () => {
    const ok = await runCheck({ type: 'assertion', checker: 'http', params: { url: `${base}/ok`, status: 200, contains: 'pong' } } as Check, {}, { assertions });
    expect(ok.passed).toBe(true);
    const bad = await runCheck({ type: 'assertion', checker: 'http', params: { url: `${base}/fail`, status: 200 } } as Check, {}, { assertions });
    expect(bad.passed).toBe(false);
  });
});

describe('Verifier — aggregation, escalation, persistence', () => {
  it('aggregates weighted confidence and marks done only on evidence', async () => {
    const v = new Verifier(cfg({ verification: { confidenceThreshold: 0.8 } }), undefined, new EventBus());
    const res = await v.verify({ goal: 'g', checks: [
      { type: 'test', command: 'node -e "process.exit(0)"', weight: 1 },
      { type: 'test', command: 'node -e "process.exit(0)"', weight: 3 },
    ] });
    expect(res.confidence).toBe(1);
    expect(res.passed).toBe(true);
    expect(res.escalated).toBe(false);
  });

  it('escalates below threshold and persists results + escalations', async () => {
    const { m, close } = await makeMercury();
    try {
      const v = m.verifier;
      const res = await v.verify({ taskId: 'task-1', goal: 'ship', checks: [
        { type: 'test', command: 'node -e "process.exit(1)"', required: true },
      ] });
      expect(res.passed).toBe(false);
      expect(res.escalated).toBe(true);
      expect(v.list('task-1').length).toBe(1);
      expect(v.get(res.id)?.id).toBe(res.id);
      const open = v.escalations('open');
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(v.resolveEscalation(open[0].id)).toBe(true);
      expect(v.escalations('open').some((e) => e.id === open[0].id)).toBe(false);
    } finally {
      await close();
    }
  });

  it('skips disabled check types (backward-compatible toggles)', async () => {
    const v = new Verifier(cfg({ verification: { checks: ['schema'] } }), undefined, new EventBus());
    const res = await v.verify({ checks: [{ type: 'test', command: 'node -e "process.exit(1)"', required: true }] });
    // the test check is filtered out, so nothing to disprove → confidence 1, done.
    expect(res.checks.length).toBe(0);
    expect(res.passed).toBe(true);
  });
});

describe('Verifier — end-to-end critic via Mercury decision engine', () => {
  it('runs a real critic check through the wired decision engine', async () => {
    const { m, close } = await makeMercury();
    try {
      const res = await m.verifier.verify({ goal: 'summarise the report', output: 'Here is a complete summary of the report.', checks: [
        { type: 'critic', goal: 'summarise the report' },
      ] });
      expect(res.checks.length).toBe(1);
      expect(res.checks[0].type).toBe('critic');
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
      expect(res.checks[0].detail).toMatch(/critic p\(satisfies\)/);
    } finally {
      await close();
    }
  });
});
