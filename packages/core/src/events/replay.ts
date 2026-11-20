/**
 * Replayable audit trail: turn a run's recorded event stream into an ordered, human-readable
 * trace that answers "why did you do that?".
 *
 * Builds on the existing {@link EventRecorder} (which persists every bus event per run). Given
 * those events this produces a chronological list of {@link TraceStep}s — each a plain-English
 * line explaining a decision, model call, tool action, approval, guardrail/taint verdict,
 * budget event or grant — plus run-level totals (cost, tokens, counts, duration). The server
 * exposes it per run and the Web UI renders it so an operator can replay exactly what happened.
 */
import type { MercuryEvent } from './bus.js';

export type TraceCategory =
  | 'lifecycle'
  | 'thought'
  | 'llm'
  | 'tool'
  | 'approval'
  | 'guardrail'
  | 'taint'
  | 'budget'
  | 'grant'
  | 'decision'
  | 'memory'
  | 'other';

export interface TraceStep {
  seq: number;
  ts: string;
  type: string;
  category: TraceCategory;
  /** One-line, human-readable explanation of this step. */
  summary: string;
  spanId?: string;
  parentSpanId?: string;
  data: Record<string, unknown>;
}

export interface RunTrace {
  runId: string;
  steps: TraceStep[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalCost: number;
  totalTokens: number;
  llmCalls: number;
  toolCalls: number;
  decisions: number;
  /** True if any tool output was tainted or any guardrail flagged injection during the run. */
  tainted: boolean;
  /** A short overall explanation of the run. */
  summary: string;
}

function categoryOf(type: string): TraceCategory {
  if (type === 'run.start' || type === 'run.end' || type === 'run.error') return 'lifecycle';
  if (type === 'thought') return 'thought';
  if (type.startsWith('llm.')) return 'llm';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('approval.')) return 'approval';
  if (type === 'guardrail') return 'guardrail';
  if (type.startsWith('taint.')) return 'taint';
  if (type.startsWith('task.budget') || type === 'budget.exceeded') return 'budget';
  if (type.startsWith('grant.')) return 'grant';
  if (type === 'decision') return 'decision';
  if (type.startsWith('memory.')) return 'memory';
  return 'other';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Build a one-line human summary for an event. */
function summarize(e: MercuryEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'run.start':
      return `Run started${str(d.input) ? `: "${truncate(str(d.input), 120)}"` : ''}.`;
    case 'run.end':
      return `Run completed${d.ok === false ? ' with errors' : ''}.`;
    case 'run.error':
      return `Run failed: ${truncate(str(d.error) || 'unknown error', 160)}.`;
    case 'thought':
      return `Thought: ${truncate(str(d.text), 160)}`;
    case 'llm.request':
      return `Asked model ${str(d.model)} (${num(d.messages)} messages, ${num(d.tools)} tools${d.textMode ? ', text-ReAct' : ''}).`;
    case 'llm.response': {
      const tools = Array.isArray(d.toolCalls) && d.toolCalls.length ? `, requested tools: ${(d.toolCalls as string[]).join(', ')}` : '';
      return `Model ${str(d.model)} replied (${num(d.inputTokens)}+${num(d.outputTokens)} tokens, $${num(d.cost).toFixed(4)}${tools}).`;
    }
    case 'llm.error':
      return `Model ${str(d.model)} errored: ${truncate(str(d.error), 140)}${d.willFallback ? ' (falling back)' : ''}.`;
    case 'llm.retry':
      return `Retrying ${str(d.model)} (attempt ${num(d.attempt)}/${num(d.maxRetries)}).`;
    case 'llm.circuit':
      return `Circuit for ${str(d.model)}: ${str(d.from)} → ${str(d.to)}.`;
    case 'tool.call':
      return `Calling tool ${str(d.name)} (risk: ${str(d.risk) || 'safe'}) with ${truncate(str(d.args), 160)}.`;
    case 'tool.result':
      return `Tool ${str(d.name)} ${d.ok ? 'succeeded' : 'failed'} in ${num(d.durationMs)}ms${d.untrusted ? ' — output marked UNTRUSTED (tainted)' : ''}.`;
    case 'tool.denied':
      return `Tool ${str(d.name)} DENIED: ${truncate(str(d.error), 160)}.`;
    case 'approval.request':
      return `Approval requested: ${truncate(str(d.title) || str(d.detail), 160)}.`;
    case 'approval.resolved':
      return `Approval ${d.approved ? 'granted' : 'denied'}${str(d.by) ? ` by ${str(d.by)}` : ''}.`;
    case 'guardrail':
      return `Guardrail (${str(d.layer)})${d.blocked ? ' BLOCKED' : ' flagged'} a possible injection on ${str(d.tool) || 'input'}.`;
    case 'taint.mark':
      return `Tainted content entered the context from ${str(d.source)}${d.suspicious ? ' (looks like an injection attempt)' : ''}.`;
    case 'decision':
      return `Decision (${str(d.kind) || 'choice'}): ${truncate(str(d.rationale) || str(d.chosen) || JSON.stringify(d), 160)}.`;
    case 'task.budget.exceeded':
      return `Per-task budget ${str(d.state) || 'exceeded'}: ${truncate(str(d.reason), 160)}.`;
    case 'grant.issued':
      return `Capability grant issued: ${str(d.capability)}${str(d.scope) ? ` (scope: ${str(d.scope)})` : ''}.`;
    case 'grant.used':
      return `Capability grant used: ${str(d.capability)} (use #${num(d.uses)}).`;
    case 'grant.denied':
      return `Capability DENIED: no valid grant for ${str(d.capability)}${str(d.scope) ? ` (scope: ${str(d.scope)})` : ''}.`;
    case 'grant.revoked':
      return `Capability grant revoked${str(d.capability) ? `: ${str(d.capability)}` : ` (${num(d.count)} grants)`}.`;
    case 'memory.write':
      return `Wrote to memory${str(d.kind) ? ` (${str(d.kind)})` : ''}.`;
    case 'memory.read':
      return `Read from memory${str(d.kind) ? ` (${str(d.kind)})` : ''}.`;
    default:
      return `${e.type}.`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Build an ordered, human-readable trace from a run's recorded events.
 * Events are sorted chronologically (stable). `runId` defaults to the first event's runId.
 */
export function buildTrace(events: MercuryEvent[], runId?: string): RunTrace {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const id = runId ?? sorted.find((e) => e.runId)?.runId ?? '';
  let totalCost = 0;
  let totalTokens = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let decisions = 0;
  let tainted = false;

  const steps: TraceStep[] = sorted.map((e, i) => {
    const d = e.data ?? {};
    if (e.type === 'llm.response') {
      llmCalls++;
      totalCost += num(d.cost);
      totalTokens += num(d.inputTokens) + num(d.outputTokens);
    }
    if (e.type === 'tool.call') toolCalls++;
    if (e.type === 'decision') decisions++;
    if ((e.type === 'tool.result' && d.untrusted) || e.type === 'taint.mark' || (e.type === 'guardrail' && d.injection)) tainted = true;
    return {
      seq: i + 1,
      ts: e.ts,
      type: e.type,
      category: categoryOf(e.type),
      summary: summarize(e),
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      data: d,
    };
  });

  const startedAt = sorted.find((e) => e.type === 'run.start')?.ts ?? sorted[0]?.ts;
  const endedAt = [...sorted].reverse().find((e) => e.type === 'run.end' || e.type === 'run.error')?.ts ?? sorted[sorted.length - 1]?.ts;
  const durationMs = startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined;

  const summary = `Run ${id || '(unknown)'}: ${llmCalls} model call(s), ${toolCalls} tool call(s), ${decisions} decision(s), $${totalCost.toFixed(4)} spent${tainted ? '; handled tainted content' : ''}.`;

  return {
    runId: id,
    steps,
    startedAt,
    endedAt,
    durationMs: durationMs !== undefined && durationMs >= 0 ? durationMs : undefined,
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    totalTokens,
    llmCalls,
    toolCalls,
    decisions,
    tainted,
    summary,
  };
}
