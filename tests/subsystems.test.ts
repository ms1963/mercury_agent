/** Tools, polyglot tools, memory, router, budgets, scheduler, workflows, skills. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidCron, nextCronRun, parseSchedule, type Principal } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let p: Principal;
let user: Principal;
beforeAll(async () => {
  ctx = await makeMercury({}, { startServices: true });
  p = await ctx.m.localPrincipal();
  user = ctx.m.users.principalFor(ctx.m.users.register('carol', 'password-3'));
});
afterAll(() => ctx.close());

const run = (name: string, args: Record<string, unknown>, who = () => p) =>
  ctx.m.executor.execute({ id: 't', name, arguments: args }, directToolContext(ctx.m, who(), 'cli'), { untrustedSeen: false, userRequest: 'test' });

describe('tools', () => {
  it('registers the built-in tool catalogue', () => {
    expect(ctx.m.tools.list().length).toBeGreaterThan(50);
    expect(ctx.m.tools.toolsets().map((t) => t.name)).toEqual(expect.arrayContaining(['files', 'memory']));
  });

  it('runs a safe tool', async () => {
    const r = await run('calculator', { expression: '(3+4)*6' });
    expect(r.ok).toBe(true);
    expect(r.result.content).toContain('42');
  });

  it('runs bundled polyglot tools (Python and JavaScript)', async () => {
    const py = await run('word_count', { text: 'one two three' });
    expect(py.result.content).toContain('3 words');
    const js = await run('slugify', { text: 'Hello World Ünïcode!' });
    expect(js.result.content).toBe('hello-world-unicode');
  });

  it('can disable a tool', async () => {
    ctx.m.tools.setToolEnabled('calculator', false);
    const r = await run('calculator', { expression: '1+1' });
    ctx.m.tools.setToolEnabled('calculator', true);
    expect(r.ok).toBe(false);
  });
});

describe('memory', () => {
  it('remembers, recalls and forgets facts per user', async () => {
    const f = await ctx.m.memory.remember(p.userId, 'The user prefers green tea over coffee', { source: 'test' });
    const hits = await ctx.m.memory.recall(p.userId, 'green tea', 5);
    expect(hits.some((h) => String((h as { content?: string }).content).includes('green tea'))).toBe(true);
    expect((await ctx.m.memory.recall(user.userId, 'green tea', 5)).length).toBe(0);
    await ctx.m.memory.forget(p.userId, (f as { id: string }).id);
    expect(ctx.m.memory.facts.list(p.userId).some((x) => x.content.includes('green tea'))).toBe(false);
  });

  it('stores curated MEMORY.md / USER.md notes', () => {
    ctx.m.memory.curated.write(p.userId, 'user', '- Name: Test User');
    expect(ctx.m.memory.curated.read(p.userId, 'user')).toContain('Test User');
  });
});

describe('router & budgets', () => {
  it('routes to the configured mock model and honours explicit models', async () => {
    const auto = await ctx.m.router.route({ task: 'write a haiku' });
    expect(auto.model.startsWith('mock/')).toBe(true);
    const explicit = await ctx.m.router.route({ task: 'x', explicitModel: 'mock/vision' });
    expect(explicit).toMatchObject({ model: 'mock/vision', reason: 'explicit' });
  });

  it('blocks a user that exceeds a token budget', async () => {
    const rule = ctx.m.budgets.setBudget({ user: user.userId, model: '*', period: 'daily', maxTokens: 100 });
    ctx.m.budgets.record(user.userId, 'mock/echo', { inputTokens: 90, outputTokens: 20 }, 0);
    expect(() => ctx.m.budgets.check(user, 'mock/echo', 10)).toThrow(/budget/);
    expect(() => ctx.m.budgets.check(p, 'mock/echo', 10)).not.toThrow();
    ctx.m.budgets.deleteBudget(rule.id);
    expect(() => ctx.m.budgets.check(user, 'mock/echo', 10)).not.toThrow();
  });
});

describe('scheduler', () => {
  it('parses natural language and cron schedules', () => {
    expect(parseSchedule('every weekday at 9am')?.kind).toBeDefined();
    expect(parseSchedule('in 10 minutes')?.kind).toBeDefined();
    expect(parseSchedule('0 */6 * * *')?.spec).toBe('0 */6 * * *');
    expect(parseSchedule('whenever you feel like it')).toBeUndefined();
    expect(isValidCron('*/5 * * * *')).toBe(true);
    const next = nextCronRun('0 9 * * *', new Date('2026-01-01T10:00:00'));
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(9);
  });

  it('creates, pauses, resumes, runs and deletes a task', async () => {
    const s = ctx.m.scheduler.create(p.userId, { when: 'every day at 9am', task: 'Say hi' });
    expect(s.status).toBe('active');
    expect(ctx.m.scheduler.pause(s.id).status).toBe('paused');
    expect(ctx.m.scheduler.resume(s.id).status).toBe('active');
    await ctx.m.scheduler.runNow(s.id);
    expect(ctx.m.scheduler.history(s.id).length).toBeGreaterThan(0);
    ctx.m.scheduler.delete(s.id);
    expect(ctx.m.scheduler.list(p.userId).find((x) => x.id === s.id)).toBeUndefined();
    expect(() => ctx.m.scheduler.create(p.userId, { when: 'gibberish o clock', task: 'x' })).toThrow(/schedule/);
  });
});

describe('workflows & skills', () => {
  it('loads bundled workflow specs and templates', () => {
    expect(ctx.m.workflows.list().map((w) => w.name)).toEqual(expect.arrayContaining(['research-report', 'debate']));
    expect(ctx.m.workflows.listTemplates().map((t) => t.type)).toEqual(expect.arrayContaining(['pipeline', 'map-reduce', 'debate', 'coordinator-worker']));
  });

  it('runs a pipeline workflow with subagents', async () => {
    const r = await ctx.m.workflows.run('research-report', 'solar power', { principal: p, platform: 'cli' });
    expect(r.steps.map((s) => s.agent)).toEqual(['researcher', 'writer']);
    expect(r.output.length).toBeGreaterThan(0);
  });

  it('runs a debate workflow', async () => {
    const r = await ctx.m.workflows.run('debate', 'Cats are better than dogs', { principal: p, platform: 'cli' });
    expect(r.steps.length).toBeGreaterThanOrEqual(3);
  });

  it('lists bundled skills and creates a new one', () => {
    expect(ctx.m.skills.list().map((s) => s.meta.name)).toEqual(expect.arrayContaining(['web-research', 'code-review']));
    ctx.m.skills.create({ name: 'unit-test-skill', description: 'Used by tests', body: '# Steps\n1. Do it' });
    expect(ctx.m.skills.view('unit-test-skill')).toContain('Do it');
  });
});
