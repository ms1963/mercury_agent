/**
 * Deterministic run replay & time-travel debugging.
 *
 * Persists lightweight per-run trace metadata (seed/options + fork lineage) and, building on the
 * already-recorded event stream, lets an operator:
 *   - load a run's full ordered, human-readable trace ({@link getTrace}),
 *   - scrub to any step and inspect the accumulated, reconstructed state ({@link getStateAt}),
 *   - fork a run from a chosen step with edited inputs ({@link replayFrom}) — reusing the upstream
 *     prefix verbatim and deterministically recomputing everything downstream, recorded as a new
 *     linked run (parent run id + forked-at step).
 *
 * Determinism: given the same recorded upstream prefix and the same (possibly edited) input, a
 * replay reproduces the same downstream path when the provider is deterministic. The seed/options
 * that make a run reproducible are persisted with the trace. Safety: a fork runs through the real
 * agent, so governance/approvals apply to the recomputed portion exactly as for a normal run.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import type { EventBus, MercuryEvent } from '../events/bus.js';
import type { EventRecorder } from '../events/recorder.js';
import { buildTrace, type RunTrace } from '../events/replay.js';
import { safeJsonParse } from '../types/common.js';
import type { ChatMessage, ToolCall } from '../types/messages.js';
import type {
  ReplayEdit,
  ReplayForkRunner,
  ReplayResult,
  ReplayState,
  RunTraceRecord,
  TraceStore,
} from './ports.js';

/** A run's full trace plus persisted metadata and fork lineage. */
export interface RunTraceView extends RunTrace {
  meta?: RunTraceRecord;
  parentRunId?: string;
  fromStep?: number;
  /** Direct forks of this run. */
  forks: Array<{ runId: string; fromStep?: number; createdAt: string }>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Stable chronological sort — identical to {@link buildTrace} so step indices line up. */
function sortEvents(events: MercuryEvent[]): MercuryEvent[] {
  return [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Parse a recorded tool.call `args` (persisted as a redacted JSON string) back to an object. */
function parseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') return safeJsonParse<Record<string, unknown>>(v) ?? {};
  return {};
}

export class TimeTravelService {
  private off: Array<() => void> = [];

  constructor(
    private config: MercuryConfig,
    private store: TraceStore,
    private recorder: EventRecorder,
    private db: Db,
    private bus: EventBus,
    /** Injected by the runtime; absent in pure unit tests that only inspect traces. */
    private forkRunner?: ReplayForkRunner,
  ) {}

  get enabled(): boolean {
    return this.config.replay.enabled;
  }

  /** Allow the runtime to wire the fork runner after the agent is constructed. */
  setForkRunner(runner: ReplayForkRunner): void {
    this.forkRunner = runner;
  }

  /** Subscribe to the bus so every run's trace metadata is captured automatically. */
  start(): void {
    if (!this.enabled || this.off.length) return;
    this.off.push(
      this.bus.on('run.start', (e) => {
        if (!e.runId) return;
        try {
          this.store.upsert({
            runId: e.runId,
            sessionId: e.sessionId,
            userId: e.userId,
            input: str(e.data?.input),
            parentRunId: str(e.data?.parentRunId) || undefined,
            seed: { platform: str(e.data?.platform) || undefined },
          });
        } catch {
          /* trace capture must never break the agent */
        }
      }),
    );
    this.off.push(
      this.bus.on('run.end', (e) => {
        if (!e.runId) return;
        try {
          const events = this.recorder.replay(e.runId);
          const trace = buildTrace(events, e.runId);
          const runRow = this.db.get<{ model: string | null; pattern: string | null }>(
            'SELECT model, pattern FROM runs WHERE id = ?',
            e.runId,
          );
          // Refresh the seed with the resolved model/pattern (lineage is preserved by the store).
          this.store.upsert({
            runId: e.runId,
            sessionId: e.sessionId,
            userId: e.userId,
            input: trace.steps.find((s) => s.type === 'run.start') ? str(events.find((ev) => ev.type === 'run.start')?.data?.input) : undefined,
            seed: { model: runRow?.model ?? undefined, pattern: runRow?.pattern ?? undefined },
          });
          this.store.update(e.runId, {
            steps: trace.steps.length,
            deltas: this.config.replay.persistDeltas ? this.buildDeltas(events) : undefined,
          });
          this.store.prune(this.config.replay.retainTraces);
        } catch {
          /* best-effort */
        }
      }),
    );
  }

  stop(): void {
    for (const off of this.off) off();
    this.off = [];
  }

  // ---- inspection -------------------------------------------------------------------------

  /** Full ordered, human-readable trace for a run, with persisted metadata + fork lineage. */
  getTrace(runId: string): RunTraceView | undefined {
    if (!this.enabled) return undefined;
    const events = this.recorder.replay(runId);
    const meta = this.store.get(runId);
    if (!events.length && !meta) return undefined;
    const trace = buildTrace(events, runId);
    const forks = this.store.children(runId).map((c) => ({ runId: c.runId, fromStep: c.fromStep, createdAt: c.createdAt }));
    return { ...trace, meta, parentRunId: meta?.parentRunId, fromStep: meta?.fromStep, forks };
  }

  /** Recent traced runs (for the run viewer). */
  listTraces(userId?: string, limit = 50): RunTraceRecord[] {
    if (!this.enabled) return [];
    return this.store.list(userId, limit);
  }

  /**
   * Reconstruct the accumulated state as of `step` (1-based count of trace steps included).
   * `step <= 0` → before the run started; `step >= total` → the final state.
   */
  getStateAt(runId: string, step: number): ReplayState | undefined {
    if (!this.enabled) return undefined;
    const events = sortEvents(this.recorder.replay(runId));
    if (!events.length) return undefined;
    const total = events.length;
    const n = Math.max(0, Math.min(Math.floor(step), total));
    return this.reconstruct(runId, events.slice(0, n), n, total);
  }

  private reconstruct(runId: string, slice: MercuryEvent[], step: number, total: number): ReplayState {
    let cost = 0;
    let tokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let decisions = 0;
    let tainted = false;
    let lastThought: string | undefined;
    let lastOutput: string | undefined;
    let input: string | undefined;
    const messages: ChatMessage[] = [];
    const toolResults: Array<{ name: string; ok: boolean; preview: string }> = [];
    let pendingAssistant: { content: string; toolCalls: ToolCall[] } | undefined;

    const flushAssistant = () => {
      if (!pendingAssistant) return;
      messages.push({ role: 'assistant', content: pendingAssistant.content, toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined });
      pendingAssistant = undefined;
    };

    for (const e of slice) {
      const d = e.data ?? {};
      switch (e.type) {
        case 'run.start':
          input = str(d.input);
          messages.push({ role: 'user', content: input });
          break;
        case 'thought':
          lastThought = str(d.text);
          break;
        case 'llm.response': {
          llmCalls++;
          cost += num(d.cost);
          tokens += num(d.inputTokens) + num(d.outputTokens);
          const names = Array.isArray(d.toolCalls) ? (d.toolCalls as unknown[]).map(String) : [];
          const content = str(d.content);
          if (names.length) {
            flushAssistant();
            pendingAssistant = { content, toolCalls: [] };
          } else {
            flushAssistant();
            if (content) {
              messages.push({ role: 'assistant', content });
              lastOutput = content;
            }
          }
          break;
        }
        case 'tool.call':
          toolCalls++;
          if (pendingAssistant) pendingAssistant.toolCalls.push({ id: str(d.id), name: str(d.name), arguments: parseArgs(d.args) });
          break;
        case 'tool.result': {
          flushAssistant();
          const name = str(d.name);
          const preview = str(d.preview);
          const ok = d.ok !== false;
          if (d.untrusted) tainted = true;
          toolResults.push({ name, ok, preview });
          messages.push({ role: 'tool', content: preview, name, toolCallId: str(d.id) || undefined, untrusted: !!d.untrusted });
          break;
        }
        case 'decision':
          decisions++;
          break;
        case 'taint.mark':
          tainted = true;
          break;
        case 'guardrail':
          if (d.injection) tainted = true;
          break;
        default:
          break;
      }
    }
    flushAssistant();

    return {
      runId,
      step,
      totalSteps: total,
      input,
      cost: Math.round(cost * 1e6) / 1e6,
      tokens,
      llmCalls,
      toolCalls,
      decisions,
      tainted,
      lastThought,
      lastOutput,
      toolResults,
      messages,
    };
  }

  /** Per-step accumulated snapshots (only persisted when config.replay.persistDeltas). */
  private buildDeltas(events: MercuryEvent[]): Array<{ step: number; cost: number; tokens: number; toolCalls: number }> {
    const sorted = sortEvents(events);
    const out: Array<{ step: number; cost: number; tokens: number; toolCalls: number }> = [];
    for (let i = 1; i <= sorted.length; i++) {
      const s = this.reconstruct('', sorted.slice(0, i), i, sorted.length);
      out.push({ step: i, cost: s.cost, tokens: s.tokens, toolCalls: s.toolCalls });
    }
    return out;
  }

  // ---- replay / fork ----------------------------------------------------------------------

  /**
   * Fork a run from `fromStep` with optional edits, reusing the upstream prefix and recomputing
   * everything downstream as a new linked run. Returns undefined when replay is disabled.
   */
  async replayFrom(runId: string, opts: { fromStep?: number; edits?: ReplayEdit; userId?: string } = {}): Promise<ReplayResult | undefined> {
    if (!this.enabled) return undefined;
    if (!this.forkRunner) throw new Error('replay fork runner not wired');
    const events = sortEvents(this.recorder.replay(runId));
    if (!events.length) throw new Error(`no recorded trace for run ${runId}`);
    const meta = this.store.get(runId);
    const total = events.length;
    const fromStep = Math.max(0, Math.min(Math.floor(opts.fromStep ?? 0), total));
    const state = this.reconstruct(runId, events.slice(0, fromStep), fromStep, total);

    // The upstream prefix is reused verbatim; the (possibly edited) input drives recomputation.
    const originalInput = str(events.find((e) => e.type === 'run.start')?.data?.input) || meta?.input || '';
    const input = opts.edits?.input ?? originalInput;
    // When forking mid-run we reuse the prefix as context; drop the leading original user turn so
    // the edited input becomes the active instruction rather than duplicating the first message.
    const prefixMessages = fromStep > 0 ? state.messages : [];

    const run = await this.forkRunner({
      parentRunId: runId,
      fromStep,
      edits: opts.edits,
      seed: meta?.seed ?? {},
      input,
      prefixMessages,
      userId: opts.userId ?? meta?.userId,
    });

    // Record the fork lineage on the new run's trace row (its run.start already created it).
    try {
      this.store.upsert({
        runId: run.runId,
        userId: opts.userId ?? meta?.userId,
        input,
        parentRunId: runId,
        fromStep,
        edits: opts.edits,
        seed: meta?.seed ?? {},
      });
    } catch {
      /* lineage is best-effort */
    }

    return { parentRunId: runId, fromStep, edits: opts.edits, run };
  }
}
