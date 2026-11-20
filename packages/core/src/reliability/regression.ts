/**
 * Record / replay regression testing.
 *
 * {@link RunRecorder} captures completed runs (the input, the tool calls made and the produced
 * output) from the real run history into the `recordings` table. {@link ReplayService} re-runs a
 * recorded input through the live agent and diffs the outcome against what was recorded — turning
 * past runs into regression tests for model, prompt or skill changes. No mocks: replays go
 * through the actual agent runner supplied by the runtime.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../types/common.js';

export interface RecordedToolCall {
  name: string;
  args?: unknown;
}

export interface Recording {
  id: string;
  name?: string;
  runId?: string;
  userId?: string;
  input: string;
  toolCalls: RecordedToolCall[];
  output: string;
  model?: string;
  createdAt: string;
}

/** Replayed-outcome diff against a recording. `match` = behaviourally equivalent (regression-free). */
export interface ReplayDiff {
  recordingId: string;
  match: boolean;
  statusMatch: boolean;
  toolMatch: boolean;
  outputSimilarity: number;
  recorded: { output: string; toolNames: string[] };
  replayed: { status: string; output: string; toolNames: string[] };
  summary: string;
}

/** A minimal run outcome the replay runner must return (subset of the agent's RunResult). */
export interface ReplayRunOutcome {
  status: string;
  output: string;
  toolNames: string[];
}

export type ReplayRunner = (input: string, userId?: string) => Promise<ReplayRunOutcome>;

/** Token Jaccard similarity in [0,1] — tolerant output comparison (LLM wording varies). */
function similarity(a: string, b: string): number {
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = norm(a);
  const sb = norm(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : Math.round((inter / union) * 1e4) / 1e4;
}

export class RunRecorder {
  private off?: () => void;

  constructor(private config: MercuryConfig, private db?: Db, private bus?: EventBus) {}

  /** Auto-record completed runs when `reliability.record` is on. */
  start(): void {
    if (this.off || !this.db) return;
    this.off = this.bus?.on('run.end', (e) => {
      if (!this.config.reliability.record || !e.runId) return;
      const status = (e.data as { status?: string } | undefined)?.status;
      if (status !== 'completed') return;
      try {
        this.record(e.runId);
      } catch {
        /* recording must never break a run */
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** Capture a run (by id) from the run + event history into a replayable recording. */
  record(runId: string, name?: string): Recording | undefined {
    if (!this.db) return undefined;
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run) return undefined;
    const toolEvents = this.db.all("SELECT data FROM events WHERE run_id = ? AND type = 'tool.call' ORDER BY ts, rowid", runId);
    const toolCalls: RecordedToolCall[] = toolEvents.map((r) => {
      const d = fromJson<{ name?: string; args?: unknown }>(r.data, {});
      return { name: String(d.name ?? ''), args: d.args };
    });
    const rec: Recording = {
      id: newId('rec'),
      name: name ?? `run ${runId.slice(0, 8)}`,
      runId,
      userId: (run.user_id as string) ?? undefined,
      input: String(run.input ?? ''),
      toolCalls,
      output: String(run.output ?? ''),
      model: (run.model as string) ?? undefined,
      createdAt: nowIso(),
    };
    this.db.run(
      'INSERT INTO recordings (id, name, run_id, user_id, input, tool_calls, output, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      rec.id, rec.name ?? null, rec.runId ?? null, rec.userId ?? null, rec.input, toJson(rec.toolCalls), rec.output, rec.model ?? null, rec.createdAt,
    );
    this.bus?.emit({ type: 'recording.created', runId, data: { id: rec.id, toolCalls: toolCalls.length } });
    return rec;
  }

  list(limit = 50): Recording[] {
    if (!this.db) return [];
    return this.db.all('SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?', limit).map((r) => this.row(r));
  }

  get(id: string): Recording | undefined {
    const r = this.db?.get('SELECT * FROM recordings WHERE id = ?', id);
    return r ? this.row(r) : undefined;
  }

  remove(id: string): boolean {
    return (this.db?.run('DELETE FROM recordings WHERE id = ?', id).changes ?? 0) > 0;
  }

  private row(r: Record<string, unknown>): Recording {
    return {
      id: String(r.id),
      name: (r.name as string) ?? undefined,
      runId: (r.run_id as string) ?? undefined,
      userId: (r.user_id as string) ?? undefined,
      input: String(r.input ?? ''),
      toolCalls: fromJson<RecordedToolCall[]>(r.tool_calls, []),
      output: String(r.output ?? ''),
      model: (r.model as string) ?? undefined,
      createdAt: String(r.created_at),
    };
  }
}

export class ReplayService {
  /** `minSimilarity` below which an output difference is treated as a possible regression. */
  constructor(private recorder: RunRecorder, private runner: ReplayRunner, private minSimilarity = 0.5) {}

  /** Re-run a recording's input and diff the outcome. */
  async replay(recordingId: string): Promise<ReplayDiff> {
    const rec = this.recorder.get(recordingId);
    if (!rec) throw new Error(`recording ${recordingId} not found`);
    const out = await this.runner(rec.input, rec.userId);
    const recordedTools = [...new Set(rec.toolCalls.map((t) => t.name).filter(Boolean))].sort();
    const replayedTools = [...new Set(out.toolNames)].sort();
    const statusMatch = out.status === 'completed' || out.status === 'stopped';
    const toolMatch = recordedTools.length === replayedTools.length && recordedTools.every((t, i) => t === replayedTools[i]);
    const outputSimilarity = similarity(rec.output, out.output);
    const match = statusMatch && toolMatch && outputSimilarity >= this.minSimilarity;
    const summary = match
      ? `no regression · tools ${replayedTools.length} match · output similarity ${outputSimilarity.toFixed(2)}`
      : `possible regression · ${!statusMatch ? `status ${out.status}; ` : ''}${!toolMatch ? `tools [${recordedTools.join(',')}]→[${replayedTools.join(',')}]; ` : ''}output similarity ${outputSimilarity.toFixed(2)}`;
    return {
      recordingId,
      match,
      statusMatch,
      toolMatch,
      outputSimilarity,
      recorded: { output: rec.output, toolNames: recordedTools },
      replayed: { status: out.status, output: out.output, toolNames: replayedTools },
      summary,
    };
  }
}
