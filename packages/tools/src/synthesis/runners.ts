/**
 * Out-of-process compile + test runners for self-extending tools.
 *
 * The core synthesis flow ({@link validateDraft}) is pure and takes INJECTED compile/test runners so
 * it is unit-testable with stubs. These are the REAL runners used by the live runtime: each writes the
 * draft's implementation (and, for the test stage, the GENERATED unit test) into a throwaway temp
 * directory and runs it in a CHILD PROCESS — never `eval`/`require` in the main runtime — with:
 *   - a scrubbed environment (no API keys or ambient secrets leak into generated code — reuses safeEnv),
 *   - a wall-clock timeout with a process-group kill (grandchildren die too),
 *   - captured + capped stdout/stderr.
 *
 * The implementation/test contract (see buildAuthoringPrompt): the implementation defines `run(args)`
 * plus a stdin/stdout main guard, and the test imports `run` from it and asserts, exiting non-zero on
 * failure. So the test exercises the implementation directly, out-of-process, before it is ever
 * registered. This host-level compile/test is the PRE-registration gate; the APPROVED tool then runs
 * through the stronger polyglot sandbox (docker/scrubbed-env, network-off-unless-declared) at use time.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerOutput, SynthCompileRunner, SynthesizedToolDraft, SynthTestRunner } from '@mercury/core';
import { safeEnv } from '../terminal/backends.js';

/** Options for the synthesis runners (mostly for tests). */
export interface SynthRunnerOptions {
  /** Wall-clock limit per child process (ms). Default 15000. */
  timeoutMs?: number;
  /** Max characters of combined stdout/stderr kept. Default 20000. */
  maxOutputChars?: number;
  /** Override the python interpreter (default 'python3'). */
  pythonBin?: string;
  /** Override the node binary (default the current process's node). */
  nodeBin?: string;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_OUTPUT = 20_000;

/** Run argv in `cwd` with a scrubbed env, timeout and process-group kill; capture capped output. */
function runChild(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<RunnerOutput> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      // No secrets: generated code and its test see only a minimal PATH/HOME/LANG.
      env: { ...safeEnv(), HOME: cwd, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: group,
    });
    let out = '';
    let timedOut = false;
    const append = (d: Buffer) => {
      out = (out + d.toString()).slice(-maxOutputChars);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const killTree = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `failed to spawn ${argv[0]}: ${err instanceof Error ? err.message : String(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, output: `${out}\n[timed out after ${timeoutMs}ms]`.trim() });
      else resolve({ ok: code === 0, output: out.trim() || `(exit ${code})` });
    });
  });
}

/** The implementation filename for a runtime (matches the polyglot persistence layout). */
function implFile(draft: SynthesizedToolDraft): string {
  return draft.runtime === 'python' ? 'main.py' : 'main.mjs';
}

function testFile(draft: SynthesizedToolDraft): string {
  return draft.runtime === 'python' ? 'test.py' : 'test.mjs';
}

/**
 * Build a real {@link SynthCompileRunner}: syntax-checks the implementation out-of-process
 * (`python3 -m py_compile` / `node --check`). No code is executed at this stage.
 */
export function makeCompileRunner(opts: SynthRunnerOptions = {}): SynthCompileRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const python = opts.pythonBin ?? 'python3';
  const node = opts.nodeBin ?? process.execPath;
  return async (draft: SynthesizedToolDraft): Promise<RunnerOutput> => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-synth-compile-'));
    try {
      const file = implFile(draft);
      writeFileSync(join(dir, file), draft.code);
      const argv = draft.runtime === 'python' ? [python, '-m', 'py_compile', file] : [node, '--check', file];
      return await runChild(argv, dir, timeoutMs, maxOutputChars);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Build a real {@link SynthTestRunner}: writes the implementation AND its generated unit test into a
 * temp dir and runs the test out-of-process. The test imports `run` from the implementation, so a
 * passing test (exit 0) proves the implementation actually works before it is ever registered.
 */
export function makeTestRunner(opts: SynthRunnerOptions = {}): SynthTestRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const python = opts.pythonBin ?? 'python3';
  const node = opts.nodeBin ?? process.execPath;
  return async (draft: SynthesizedToolDraft): Promise<RunnerOutput> => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-synth-test-'));
    try {
      writeFileSync(join(dir, implFile(draft)), draft.code);
      writeFileSync(join(dir, testFile(draft)), draft.test);
      const argv = draft.runtime === 'python' ? [python, testFile(draft)] : [node, testFile(draft)];
      return await runChild(argv, dir, timeoutMs, maxOutputChars);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Convenience: both real runners sharing one set of options, for wiring a ValidatorDeps. */
export function makeSynthRunners(opts: SynthRunnerOptions = {}): { compile: SynthCompileRunner; test: SynthTestRunner } {
  return { compile: makeCompileRunner(opts), test: makeTestRunner(opts) };
}
