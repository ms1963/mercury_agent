/**
 * Built-in verification — check types and their runners.
 *
 * A task/step may carry one or more declarative {@link Check}s that must pass before the task
 * is considered done. Four check types are supported:
 *   - test      : run a command/test; exit 0 (and optional expected substring) passes.
 *   - schema    : validate the step's structured result against a JSON-schema-like shape.
 *   - critic    : a second model pass (via the decision engine) judges whether the output
 *                 actually satisfies the goal.
 *   - assertion : a pluggable real-world predicate (e.g. "did the email arrive?"); the
 *                 framework ships at least one concrete, non-mocked checker (http, file).
 *
 * Every check yields a {@link CheckResult} with a 0..1 score; the {@link Verifier} aggregates
 * them into an overall confidence. No mocks here — the test runner really spawns a process,
 * the http assertion really performs a request, the file assertion really hits the filesystem.
 */
import { exec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { newId } from '../types/common.js';

export type CheckType = 'test' | 'schema' | 'critic' | 'assertion';

export interface BaseCheck {
  id?: string;
  type: CheckType;
  /** Relative weight in the confidence aggregation (default 1). */
  weight?: number;
  /** If true, this check failing fails the whole verification regardless of aggregate score. */
  required?: boolean;
  description?: string;
}

export interface TestCheck extends BaseCheck {
  type: 'test';
  /** Shell command to run; exit code 0 passes. */
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** Optional substring that must appear in stdout/stderr for the check to pass. */
  expect?: string;
}

export interface SchemaCheck extends BaseCheck {
  type: 'schema';
  /** JSON-schema-like shape the result must satisfy. */
  schema: JsonShape;
  /** Dotted path into the result to validate; defaults to the whole result. */
  path?: string;
}

export interface CriticCheck extends BaseCheck {
  type: 'critic';
  /** The goal the step output must satisfy; the critic judges whether it does. */
  goal?: string;
}

export interface AssertionCheck extends BaseCheck {
  type: 'assertion';
  /** Name of a registered checker (see {@link AssertionRegistry}). */
  checker: string;
  params?: Record<string, unknown>;
}

export type Check = TestCheck | SchemaCheck | CriticCheck | AssertionCheck;

export interface CheckResult {
  id: string;
  type: CheckType;
  passed: boolean;
  /** 0..1 contribution to the aggregate confidence. */
  score: number;
  weight: number;
  required: boolean;
  detail: string;
}

/** Minimal JSON-schema-like shape used by schema checks (no external dependency). */
export interface JsonShape {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonShape>;
  required?: string[];
  items?: JsonShape;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
}

/** A real-world predicate. Implementations must perform real work (I/O, network) — never mock. */
export type AssertionChecker = (
  params: Record<string, unknown>,
  ctx: { output?: string; result?: unknown },
) => Promise<{ passed: boolean; detail: string }>;

/** Context the critic needs to judge an output against its goal. 0..1 confidence back. */
export type CriticFn = (goal: string, output: string) => Promise<{ passed: boolean; confidence: number; detail: string }>;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

function pathInto(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);
}

/** Validate a value against a {@link JsonShape}; returns the list of violations ([] = valid). */
export function validateShape(value: unknown, shape: JsonShape, pathPrefix = '$'): string[] {
  const errs: string[] = [];
  if (value === null || value === undefined) {
    if (shape.nullable || shape.type === 'null') return errs;
    errs.push(`${pathPrefix}: expected ${shape.type ?? 'value'}, got ${value === null ? 'null' : 'undefined'}`);
    return errs;
  }
  const t = shape.type;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) errs.push(`${pathPrefix}: expected integer, got ${actual}`);
  } else if (t && t !== 'null' && actual !== t) {
    errs.push(`${pathPrefix}: expected ${t}, got ${actual}`);
  }
  if (shape.enum && !shape.enum.some((e) => e === value)) errs.push(`${pathPrefix}: value not in enum`);
  if (typeof value === 'string' && shape.minLength !== undefined && value.length < shape.minLength) errs.push(`${pathPrefix}: shorter than minLength ${shape.minLength}`);
  if (typeof value === 'number') {
    if (shape.minimum !== undefined && value < shape.minimum) errs.push(`${pathPrefix}: below minimum ${shape.minimum}`);
    if (shape.maximum !== undefined && value > shape.maximum) errs.push(`${pathPrefix}: above maximum ${shape.maximum}`);
  }
  if (shape.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of shape.required ?? []) if (!(key in obj)) errs.push(`${pathPrefix}.${key}: required`);
    for (const [key, sub] of Object.entries(shape.properties ?? {})) if (key in obj) errs.push(...validateShape(obj[key], sub, `${pathPrefix}.${key}`));
  }
  if (shape.type === 'array' && Array.isArray(value) && shape.items) value.forEach((v, i) => errs.push(...validateShape(v, shape.items!, `${pathPrefix}[${i}]`)));
  return errs;
}

/** Run a command and resolve its exit code, stdout and stderr. Real process spawn. */
function runCommand(command: string, cwd: string | undefined, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** The default assertion registry: real-world predicates with no mocking. */
export function defaultAssertionRegistry(): Map<string, AssertionChecker> {
  const reg = new Map<string, AssertionChecker>();
  // "Did the resource come up?" — a real HTTP request; passes when the status matches.
  reg.set('http', async (params) => {
    const url = String(params.url ?? '');
    if (!url) return { passed: false, detail: 'http assertion requires a url' };
    const expect = typeof params.status === 'number' ? params.status : undefined;
    const contains = typeof params.contains === 'string' ? params.contains : undefined;
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 10_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: String(params.method ?? 'GET'), signal: ctrl.signal });
      const body = contains ? await res.text() : '';
      const statusOk = expect === undefined ? res.ok : res.status === expect;
      const bodyOk = contains === undefined || body.includes(contains);
      return { passed: statusOk && bodyOk, detail: `HTTP ${res.status}${contains ? ` · contains "${contains}": ${bodyOk}` : ''}` };
    } catch (err) {
      return { passed: false, detail: `request failed: ${String((err as Error).message ?? err)}` };
    } finally {
      clearTimeout(timer);
    }
  });
  // "Was the artefact written?" — a real filesystem check.
  reg.set('file_exists', async (params) => {
    const path = String(params.path ?? '');
    if (!path) return { passed: false, detail: 'file_exists assertion requires a path' };
    const ok = existsSync(path);
    const minBytes = typeof params.minBytes === 'number' ? params.minBytes : 0;
    const size = ok ? statSync(path).size : 0;
    return { passed: ok && size >= minBytes, detail: ok ? `exists (${size} bytes)` : 'missing' };
  });
  return reg;
}

/** Run a single check, returning a scored {@link CheckResult}. */
export async function runCheck(
  check: Check,
  ctx: { output?: string; result?: unknown },
  deps: { critic?: CriticFn; assertions: Map<string, AssertionChecker> },
): Promise<CheckResult> {
  const id = check.id ?? newId('chk');
  const weight = check.weight !== undefined && check.weight > 0 ? check.weight : 1;
  const required = check.required ?? false;
  const base = { id, type: check.type, weight, required };
  try {
    if (check.type === 'test') {
      const { code, out } = await runCommand(check.command, check.cwd, check.timeoutMs ?? 60_000);
      const exitOk = code === 0;
      const expectOk = check.expect === undefined || out.includes(check.expect);
      const passed = exitOk && expectOk;
      return { ...base, passed, score: passed ? 1 : 0, detail: `exit ${code}${check.expect ? ` · expect "${check.expect}": ${expectOk}` : ''}${out ? ` · ${out.slice(0, 200)}` : ''}` };
    }
    if (check.type === 'schema') {
      const target = pathInto(ctx.result, check.path);
      const errs = validateShape(target, check.schema);
      return { ...base, passed: errs.length === 0, score: errs.length === 0 ? 1 : 0, detail: errs.length ? errs.slice(0, 5).join('; ') : 'schema valid' };
    }
    if (check.type === 'critic') {
      if (!deps.critic) return { ...base, passed: false, score: 0, detail: 'no critic available' };
      const goal = check.goal ?? '';
      const r = await deps.critic(goal, ctx.output ?? (ctx.result !== undefined ? JSON.stringify(ctx.result) : ''));
      return { ...base, passed: r.passed, score: clamp01(r.confidence), detail: r.detail };
    }
    // assertion
    const checker = deps.assertions.get(check.checker);
    if (!checker) return { ...base, passed: false, score: 0, detail: `unknown assertion checker "${check.checker}"` };
    const r = await checker(check.params ?? {}, ctx);
    return { ...base, passed: r.passed, score: r.passed ? 1 : 0, detail: r.detail };
  } catch (err) {
    return { ...base, passed: false, score: 0, detail: `check errored: ${String((err as Error).message ?? err)}` };
  }
}
