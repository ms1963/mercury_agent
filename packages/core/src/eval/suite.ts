/**
 * Self-evaluation harness.
 *
 * A small, deterministic benchmark Mercury can run against itself to catch
 * regressions and prove end-to-end agent behaviour without any external service.
 * The built-in suite is designed to pass with the offline mock provider
 * (`MERCURY_ENABLE_MOCK=1`): plain round-trip answers, tool selection, tool-result
 * feedback and memory writes. Each task declares a declarative `check`; scoring is
 * a pure function so it is trivially unit-testable.
 *
 * The harness is transport-agnostic: `runEvalSuite` takes a `runner` that executes
 * one task and returns an observation (output text, tools used, token usage, cost,
 * duration). The CLI wires that runner to the real agent and derives token/cost
 * from the usage ledger, so the eval doubles as a cost-accounting demonstration.
 */

/** Declarative pass/fail conditions for a task. All present conditions must hold to pass. */
export interface EvalCheck {
  /** Output must contain each of these substrings (case-insensitive). */
  contains?: string[];
  /** Output must NOT contain any of these substrings (case-insensitive). */
  notContains?: string[];
  /** Output must match this regular expression. */
  regex?: string;
  /** The named tool must have been invoked during the run. */
  toolCalled?: string;
}

export interface EvalTask {
  id: string;
  /** User input sent to the agent. */
  prompt: string;
  /** Human-readable description of what the task verifies. */
  description: string;
  /** Coarse labels for filtering (e.g. "tools", "memory", "basic"). */
  tags: string[];
  check: EvalCheck;
}

/** What a runner observes after executing one task. */
export interface EvalObservation {
  output: string;
  toolNames: string[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  /** Set when the run itself failed (threw) rather than producing output. */
  error?: string;
}

export interface EvalResult {
  id: string;
  description: string;
  tags: string[];
  pass: boolean;
  /** Fraction of individual conditions satisfied, 0..1. */
  score: number;
  reasons: string[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  /** Mean per-task score, 0..1. */
  score: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  results: EvalResult[];
}

export type EvalRunner = (task: EvalTask) => Promise<EvalObservation>;

const has = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());

/** Pure scoring: evaluate one observation against a task's declared checks. */
export function scoreTask(task: EvalTask, obs: EvalObservation): EvalResult {
  const reasons: string[] = [];
  const conditions: boolean[] = [];

  if (obs.error) reasons.push(`run error: ${obs.error}`);

  for (const sub of task.check.contains ?? []) {
    const ok = has(obs.output, sub);
    conditions.push(ok);
    if (!ok) reasons.push(`missing expected text "${sub}"`);
  }
  for (const sub of task.check.notContains ?? []) {
    const ok = !has(obs.output, sub);
    conditions.push(ok);
    if (!ok) reasons.push(`contains forbidden text "${sub}"`);
  }
  if (task.check.regex !== undefined) {
    const ok = new RegExp(task.check.regex, 'i').test(obs.output);
    conditions.push(ok);
    if (!ok) reasons.push(`output did not match /${task.check.regex}/`);
  }
  if (task.check.toolCalled !== undefined) {
    const ok = obs.toolNames.includes(task.check.toolCalled);
    conditions.push(ok);
    if (!ok) reasons.push(`tool "${task.check.toolCalled}" was not called (called: ${obs.toolNames.join(', ') || 'none'})`);
  }

  const total = conditions.length || 1;
  const satisfied = conditions.filter(Boolean).length;
  const pass = !obs.error && conditions.length > 0 && satisfied === conditions.length;
  return {
    id: task.id,
    description: task.description,
    tags: task.tags,
    pass,
    score: pass ? 1 : satisfied / total,
    reasons: pass ? ['ok'] : reasons,
    inputTokens: obs.inputTokens,
    outputTokens: obs.outputTokens,
    cost: obs.cost,
    durationMs: obs.durationMs,
  };
}

/**
 * Built-in deterministic benchmark. Designed to pass against the offline mock
 * provider so Mercury can verify its own agent loop, tool dispatch and memory
 * end-to-end with no network and no API keys.
 */
export const BUILTIN_EVALS: EvalTask[] = [
  {
    id: 'basic-roundtrip',
    prompt: 'Say hello to the Mercury team',
    description: 'Plain message returns a coherent round-trip answer',
    tags: ['basic'],
    check: { contains: ['hello to the Mercury team'] },
  },
  {
    id: 'tool-explicit-calculator',
    prompt: 'call:calculator {"expression":"6*7"}',
    description: 'Explicit tool request dispatches the calculator and feeds the result back',
    tags: ['tools'],
    check: { toolCalled: 'calculator', contains: ['42'] },
  },
  {
    id: 'tool-nl-calculator',
    prompt: 'calculate 2+3*4',
    description: 'Natural-language arithmetic is routed to the calculator tool (operator precedence)',
    tags: ['tools', 'reasoning'],
    check: { toolCalled: 'calculator', contains: ['14'] },
  },
  {
    id: 'memory-write',
    prompt: 'call:memory_store {"content":"the Mercury mascot is a silver falcon"}',
    description: 'A memory instruction is persisted via the long-term memory tool',
    tags: ['memory', 'tools'],
    check: { toolCalled: 'memory_store', contains: ['Stored memory'] },
  },
  {
    id: 'tool-result-grounding',
    prompt: 'call:calculator {"expression":"100-58"}',
    description: 'Final answer is grounded in the actual tool result, not hallucinated',
    tags: ['tools', 'grounding'],
    check: { toolCalled: 'calculator', contains: ['42'] },
  },
];

/** Select built-in tasks, optionally filtered by tag. */
export function selectEvals(tag?: string): EvalTask[] {
  if (!tag) return BUILTIN_EVALS;
  return BUILTIN_EVALS.filter((t) => t.tags.includes(tag));
}

/** Run a suite with the given runner and aggregate the results into a report. */
export async function runEvalSuite(tasks: EvalTask[], runner: EvalRunner): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    let obs: EvalObservation;
    try {
      obs = await runner(task);
    } catch (err) {
      obs = { output: '', toolNames: [], inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0, error: err instanceof Error ? err.message : String(err) };
    }
    results.push(scoreTask(task, obs));
  }
  const passed = results.filter((r) => r.pass).length;
  const sum = (sel: (r: EvalResult) => number): number => results.reduce((n, r) => n + sel(r), 0);
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    score: results.length ? sum((r) => r.score) / results.length : 0,
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cost: sum((r) => r.cost),
    durationMs: sum((r) => r.durationMs),
    results,
  };
}
