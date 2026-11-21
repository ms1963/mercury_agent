/**
 * Feature — Self-distilling skills.
 *
 * Covers the full lifecycle against real subsystems (SQLite skill store, event bus, agent loop,
 * mock LLM via isolated Mercury instances; no product-code mocks):
 *   - distilling a well-formed, parameterized skill from a winning run trace,
 *   - dedup/versioning when a similar run is distilled again,
 *   - governance gating (pending until approved; auto-approve policy),
 *   - the agent/planner matching an APPROVED skill and surfacing its proven path as a hint,
 *   - running outcome stats updating on reuse,
 *   - auto-retire once the success rate drops below threshold over N uses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { newId, type Principal } from '@mercury/core';
import { makeMercury } from './helpers.js';

// Disable the async post-run reflector so it cannot consume queued mock responses between runs
// (it would otherwise make the multi-run dedup/versioning cases nondeterministic).
const distillCfg = (o: Record<string, unknown> = {}) => ({
  skills: { distill: { enabled: true, ...o } },
  reflection: { enabled: false },
});

/** Drive a run that makes two real calculator tool calls, so the trace is eligible to distil. */
async function twoToolRun(m: Awaited<ReturnType<typeof makeMercury>>['m'], p: Principal, input: string, exprs: [string, string]) {
  const mock = m.providers.get('mock') as { enqueue: (...r: unknown[]) => void };
  mock.enqueue(
    { toolCalls: [{ id: newId('call'), name: 'calculator', arguments: { expression: exprs[0] } }] },
    { toolCalls: [{ id: newId('call'), name: 'calculator', arguments: { expression: exprs[1] } }] },
    { content: 'All done.' },
  );
  return m.commands.handle({ principal: p, input, platform: 'cli' });
}

describe('self-distilling skills — distillation from a winning run', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('distils a well-formed, parameterized skill from a successful two-tool run', async () => {
    ctx = await makeMercury(distillCfg(), { startServices: true });
    const p = await ctx.m.localPrincipal();
    const r = await twoToolRun(ctx.m, p, 'Add the quarterly revenue figures together', ['1200+3400', '5600+7800']);
    expect(r.run?.status).toBe('completed');

    const skills = ctx.m.distiller.list();
    expect(skills.length).toBe(1);
    const s = skills[0]!;
    // Two generalized steps, both the calculator tool, with the concrete args turned into slots.
    expect(s.steps.map((x) => x.tool)).toEqual(['calculator', 'calculator']);
    expect(s.params.length).toBeGreaterThanOrEqual(1);
    for (const step of s.steps) {
      for (const v of Object.values(step.args)) {
        expect(typeof v === 'string' && /\{\w+\}/.test(v)).toBe(true); // every concrete arg → {slot}
      }
    }
    expect(s.trigger).toContain('quarterly revenue');
    expect(s.version).toBe(1);
    expect(s.sourceRuns).toContain(r.run?.runId);
  });

  it('does not distil when the run makes fewer tool calls than minToolCalls', async () => {
    ctx = await makeMercury(distillCfg({ minToolCalls: 2 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    // A single explicit tool call → only one tool.call event → below threshold.
    await ctx.m.commands.handle({ principal: p, input: 'call:calculator {"expression":"2+2"}', platform: 'cli' });
    expect(ctx.m.distiller.list().length).toBe(0);
  });
});

describe('self-distilling skills — dedup / versioning', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('versions the existing skill when a similar run is distilled again (no duplicate)', async () => {
    ctx = await makeMercury(distillCfg({ dedupMinSimilarity: 0.5 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Combine the monthly sales totals for the report', ['10+20', '30+40']);
    const first = ctx.m.distiller.list();
    expect(first.length).toBe(1);

    await twoToolRun(ctx.m, p, 'Combine the monthly sales totals once more', ['50+60', '70+80']);
    const after = ctx.m.distiller.list();
    expect(after.length).toBe(1); // deduped, not a second skill
    expect(after[0]!.id).toBe(first[0]!.id);
    expect(after[0]!.version).toBe(2);
    expect(after[0]!.sourceRuns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('self-distilling skills — governance gating', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('leaves a new skill pending until approved; only then is it matchable', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: false, matchMinSimilarity: 0.3 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Tally the expense line items in the spreadsheet', ['5+5', '6+6']);
    const s = ctx.m.distiller.list()[0]!;
    expect(s.status).toBe('pending');
    // pending skills are not matched by the planner
    expect(ctx.m.distiller.match('Tally the expense line items in the spreadsheet')).toBeUndefined();

    const approved = ctx.m.distiller.approve(s.id);
    expect(approved?.status).toBe('approved');
    expect(ctx.m.distiller.match('Tally the expense line items in the spreadsheet')).toBeTruthy();
  });

  it('auto-approves newly distilled skills when the policy is on', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: true }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Sum the invoice amounts for billing', ['1+1', '2+2']);
    expect(ctx.m.distiller.list()[0]!.status).toBe('approved');
  });
});

describe('self-distilling skills — agent/planner reuse', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('surfaces an approved skill as a proven-path hint carrying its tool sequence', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: true, matchMinSimilarity: 0.3 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Calculate the combined shipping and handling cost', ['3+4', '5+6']);
    const hint = ctx.m.distiller.planHintFor('Calculate the combined shipping and handling cost again');
    expect(hint).toBeTruthy();
    expect(hint!.skill.status).toBe('approved');
    expect(hint!.text).toContain('Proven skill');
    expect(hint!.text).toContain('calculator');
    expect(hint!.similarity).toBeGreaterThanOrEqual(0.3);
  });

  it('injects the proven-skill hint into the agent system prompt on a matching request', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: true, matchMinSimilarity: 0.3 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Average the two benchmark scores for the summary', ['80+90', '70+60']);
    const mock = ctx.m.providers.get('mock') as { enqueue: (...r: unknown[]) => void; calls: Array<{ messages: Array<{ role: string; content: string }> }> };
    mock.enqueue({ content: 'Echo.' });
    await ctx.m.commands.handle({ principal: p, input: 'Average the two benchmark scores for the summary please', platform: 'cli' });
    const sys = mock.calls.at(-1)!.messages.find((msg) => msg.role === 'system')!.content;
    expect(sys).toContain('Proven skill');
  });
});

describe('self-distilling skills — stats and auto-retire', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>> | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('updates running outcome stats when a skill is reused', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: true }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Add two numbers for the ledger entry', ['9+9', '8+8']);
    const s = ctx.m.distiller.list()[0]!;
    expect(s.stats.uses).toBe(0);

    ctx.m.distiller.recordOutcome(s.id, { success: true, cost: 0.01, tokens: 100 });
    ctx.m.distiller.recordOutcome(s.id, { success: true, cost: 0.03, tokens: 200 });
    const after = ctx.m.distiller.get(s.id)!;
    expect(after.stats.uses).toBe(2);
    expect(after.stats.successes).toBe(2);
    expect(after.stats.successRate).toBe(1);
    expect(after.stats.avgCost).toBeCloseTo(0.02, 6);
    expect(after.stats.avgTokens).toBe(150);
    expect(after.stats.lastUsed).toBeTruthy();
  });

  it('auto-retires an approved skill once success rate drops below threshold over N uses', async () => {
    ctx = await makeMercury(distillCfg({ autoApprove: true, minRunsBeforeRetire: 3, retireBelowSuccessRate: 0.5 }), { startServices: true });
    const p = await ctx.m.localPrincipal();
    await twoToolRun(ctx.m, p, 'Add the two sensor readings together', ['11+11', '22+22']);
    const s = ctx.m.distiller.list()[0]!;
    ctx.m.distiller.recordOutcome(s.id, { success: true });
    ctx.m.distiller.recordOutcome(s.id, { success: false });
    expect(ctx.m.distiller.get(s.id)!.status).toBe('approved'); // only 2 uses so far
    const final = ctx.m.distiller.recordOutcome(s.id, { success: false }); // 3rd use → 1/3 success < 0.5
    expect(final?.status).toBe('retired');
    // retired skills are no longer matched
    expect(ctx.m.distiller.match('Add the two sensor readings together')).toBeUndefined();
  });
});
