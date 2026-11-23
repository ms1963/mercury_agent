/**
 * Feature — Deterministic run replay & time-travel debugging.
 *
 * Exercised against real subsystems (SQLite trace store, event bus/recorder, agent loop, mock LLM
 * via isolated Mercury instances; no product-code mocks):
 *   - a run's full ordered trace is persisted and reloadable with correct steps/payloads,
 *   - getStateAt reconstructs the accumulated state (messages, llm/tool counts) at a given step,
 *   - replayFrom forks from a step with an edited input, reusing the upstream prefix and recording
 *     a new linked run (parent run id + fromStep),
 *   - governance/approvals still gate side-effecting tools on the recomputed portion,
 *   - the replay.enabled=false toggle disables persistence and the facade gracefully.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, type Principal } from '@mercury/core';
import { makeMercury } from './helpers.js';

// Disable the async post-run reflector so it cannot consume queued mock responses between runs.
const replayCfg = (o: Record<string, unknown> = {}) => ({
  reflection: { enabled: false },
  replay: { enabled: true, ...o },
});

/** Drive a run that makes two real calculator tool calls, so the trace has a few ordered steps. */
async function twoToolRun(m: Awaited<ReturnType<typeof makeMercury>>['m'], p: Principal, input: string, exprs: [string, string]) {
  const mock = m.providers.get('mock') as unknown as { enqueue: (...r: unknown[]) => void };
  mock.enqueue(
    { toolCalls: [{ id: newId('call'), name: 'calculator', arguments: { expression: exprs[0] } }] },
    { toolCalls: [{ id: newId('call'), name: 'calculator', arguments: { expression: exprs[1] } }] },
    { content: 'All done.' },
  );
  return m.commands.handle({ principal: p, input, platform: 'cli' });
}

describe('run replay — trace persistence & reconstruction', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('persists a run trace that loads with correctly ordered steps and payloads', async () => {
    ctx = await makeMercury(replayCfg(), { startServices: true });
    const p = await ctx.m.localPrincipal();
    const r = await twoToolRun(ctx.m, p, 'Add the quarterly figures', ['1200+3400', '5600+7800']);
    const runId = r.run!.runId;

    const trace = ctx.m.traces.getTrace(runId);
    expect(trace).toBeDefined();
    expect(trace!.runId).toBe(runId);
    // Steps are strictly ordered by sequence and carry recorded payloads.
    const seqs = trace!.steps.map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(trace!.steps.length).toBeGreaterThan(0);
    expect(trace!.steps.some((s) => s.type === 'run.start')).toBe(true);
    expect(trace!.steps.some((s) => s.type === 'tool.call')).toBe(true);
    expect(trace!.toolCalls).toBe(2);
    expect(trace!.llmCalls).toBeGreaterThanOrEqual(2);

    // And it is listed by the trace store.
    const list = ctx.m.traces.listTraces();
    expect(list.some((t) => t.runId === runId)).toBe(true);
  });

  it('reconstructs accumulated state at a given step with getStateAt', async () => {
    ctx = await makeMercury(replayCfg(), { startServices: true });
    const p = await ctx.m.localPrincipal();
    const r = await twoToolRun(ctx.m, p, 'Sum up the totals', ['2+2', '3+3']);
    const runId = r.run!.runId;
    const trace = ctx.m.traces.getTrace(runId)!;
    const total = trace.steps.length;

    // Before anything happened: empty accumulation.
    const atZero = ctx.m.traces.getStateAt(runId, 0)!;
    expect(atZero).toBeDefined();
    expect(atZero.toolCalls).toBe(0);
    expect(atZero.llmCalls).toBe(0);

    // At the end: the full accumulated state, monotonically >= an earlier step.
    const atEnd = ctx.m.traces.getStateAt(runId, total)!;
    expect(atEnd.toolCalls).toBe(2);
    expect(atEnd.llmCalls).toBeGreaterThanOrEqual(2);
    expect(atEnd.messages.some((msg) => msg.role === 'user')).toBe(true);
    expect(atEnd.messages.some((msg) => msg.role === 'assistant')).toBe(true);
    expect(atEnd.toolCalls).toBeGreaterThanOrEqual(atZero.toolCalls);
    expect(atEnd.step).toBeLessThanOrEqual(atEnd.totalSteps);
  });
});

describe('run replay — fork / time-travel from a step', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('forks from a step with an edited input, reusing the upstream prefix and recording lineage', async () => {
    ctx = await makeMercury(replayCfg(), { startServices: true });
    const m = ctx.m;
    const p = await m.localPrincipal();
    const r = await twoToolRun(m, p, 'Add the quarterly figures', ['1200+3400', '5600+7800']);
    const parentRunId = r.run!.runId;
    const parentTrace = m.traces.getTrace(parentRunId)!;
    const fromStep = Math.max(1, Math.floor(parentTrace.steps.length / 2));

    // The fork re-runs the agent from fromStep; enqueue its (deterministic) downstream turn.
    const mock = m.providers.get('mock') as unknown as { enqueue: (...r: unknown[]) => void };
    mock.enqueue({ content: 'Recomputed with the edited input.' });

    const res = await m.traces.replayFrom(parentRunId, { fromStep, edits: { input: 'Add the yearly figures instead' }, userId: p.userId });
    expect(res).toBeDefined();
    expect(res!.parentRunId).toBe(parentRunId);
    expect(res!.fromStep).toBe(fromStep);
    const newRunId = res!.run.runId;
    expect(newRunId).not.toBe(parentRunId);

    // The new run is recorded as a linked child: parent id + forked-at step persisted.
    const forkTrace = m.traces.getTrace(newRunId)!;
    expect(forkTrace.parentRunId).toBe(parentRunId);
    expect(forkTrace.fromStep).toBe(fromStep);
    expect(forkTrace.meta?.edits?.input).toBe('Add the yearly figures instead');

    // The parent now lists this fork among its children.
    const refreshedParent = m.traces.getTrace(parentRunId)!;
    expect(refreshedParent.forks.some((f) => f.runId === newRunId)).toBe(true);
  });

  it('applies governance/approvals on the recomputed portion of a fork', async () => {
    // approvals.mode='deny' hard-denies every non-safe tool; the recomputed portion must respect it.
    ctx = await makeMercury({ ...replayCfg(), tools: { approvals: { mode: 'deny' } } }, { startServices: true });
    const m = ctx.m;
    const p = await m.localPrincipal();
    const r = await twoToolRun(m, p, 'Add the quarterly figures', ['1200+3400', '5600+7800']);
    const parentRunId = r.run!.runId;

    // Fork: the recomputed downstream tries a side-effecting (moderate) write_file call.
    const target = join(ctx.dir, 'should-not-be-written.txt');
    const mock = m.providers.get('mock') as unknown as { enqueue: (...r: unknown[]) => void };
    mock.enqueue(
      { toolCalls: [{ id: newId('call'), name: 'write_file', arguments: { path: target, content: 'governed out' } }] },
      { content: 'Finished (write was denied).' },
    );

    const res = await m.traces.replayFrom(parentRunId, { fromStep: 2, edits: { input: 'Now save the result to a file' }, userId: p.userId });
    expect(res).toBeDefined();
    // Governance held: the denied tool never executed, so no file was produced.
    expect(existsSync(target)).toBe(false);
  });
});

describe('run replay — config toggle', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('replay.enabled=false disables trace persistence and the facade gracefully', async () => {
    ctx = await makeMercury({ reflection: { enabled: false }, replay: { enabled: false } }, { startServices: true });
    const m = ctx.m;
    const p = await m.localPrincipal();
    const r = await twoToolRun(m, p, 'Add the quarterly figures', ['1200+3400', '5600+7800']);
    const runId = r.run!.runId;

    expect(m.traces.enabled).toBe(false);
    expect(m.traces.getTrace(runId)).toBeUndefined();
    expect(m.traces.getStateAt(runId, 1)).toBeUndefined();
    expect(m.traces.listTraces()).toEqual([]);
    await expect(m.traces.replayFrom(runId, { fromStep: 1 })).resolves.toBeUndefined();
  });
});
