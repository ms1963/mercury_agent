/**
 * Regression tests for the residual findings closed on the `gaps` branch:
 *  R7 — auxiliary (system-principal) LLM calls made on behalf of a user are checked against and
 *       charged to that user's budget; security decisions stay exempt.
 *  R8 — JSON-schema tools (no zod schema) enforce additionalProperties:false and numeric/string bounds,
 *       also after a before_tool_call hook rewrites the arguments.
 *  R9 — tools that ignore their abort signal are tracked as runaway and further calls are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTopLevelTypes, currentBudgetOwner, SYSTEM_PRINCIPAL, ToolExecutor, withBudgetOwner } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { makeMercury } from './helpers.js';

describe('R7 auxiliary calls are charged to the user they run for', () => {
  it('withBudgetOwner carries a user principal but never the system principal', async () => {
    const user = { kind: 'user', userId: 'u1', username: 'eve', role: 'user' } as never;
    expect(currentBudgetOwner()).toBeUndefined();
    await withBudgetOwner(user, async () => {
      await Promise.resolve();
      expect(currentBudgetOwner()).toBe(user);
    });
    withBudgetOwner(SYSTEM_PRINCIPAL, () => expect(currentBudgetOwner()).toBeUndefined());
  });

  it("a system call inside a user's context hits the user's default budget and is recorded to the user", async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      // Outside any user context the system call is not covered by the '*' rule.
      ctx.m.budgets.setBudget({ user: '*', model: '*', period: 'daily', maxTokens: 5 } as never);
      await expect(ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'hello there' }], { budgetOverride: true })).resolves.toBeTruthy();
      // On behalf of eve it is checked against eve's budget...
      await expect(
        withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'hello there' }], { budgetOverride: true })),
      ).rejects.toThrow(/budget exceeded/);
      // ...but a security decision is never blocked by the user's budget.
      await expect(
        withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'decide' }], { budgetOverride: true, kind: 'decision' })),
      ).resolves.toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  it('usage of an auxiliary call made for a user lands on that user', async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      await withBudgetOwner(eve, () => ctx.m.llm.complete(SYSTEM_PRINCIPAL, [{ role: 'user', content: 'summarise' }]));
      const rows = ctx.m.db.all<{ user_id: string; kind: string }>('SELECT user_id, kind FROM usage');
      expect(rows).toContainEqual({ user_id: eve.userId, kind: 'auxiliary' });
      expect(rows.some((r) => r.user_id === 'system')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("an agent run's own budget check still fails for an exhausted user (end to end)", async () => {
    const ctx = await makeMercury({ budgets: { enabled: true } });
    try {
      ctx.m.users.register('root', 'password-123');
      const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
      ctx.m.budgets.setBudget({ user: 'eve', model: '*', period: 'daily', maxTokens: 5 } as never);
      const r = await ctx.m.agent.run({ principal: eve, input: 'hello', platform: 'test', ephemeral: true, reflect: false }).catch((e: Error) => ({ status: 'error', error: e.message }));
      expect(JSON.stringify(r)).toMatch(/budget/i);
    } finally {
      await ctx.close();
    }
  });
});

describe('R8 JSON-schema argument enforcement', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'number', minimum: 0, maximum: 10 }, s: { type: 'string', maxLength: 3 }, l: { type: 'array', maxItems: 2 } },
    required: ['n'],
    additionalProperties: false,
  } as never;
  it('rejects out-of-range numbers (also numeric strings), long strings, long arrays and unknown keys', () => {
    expect(checkTopLevelTypes(schema, { n: 999 })).toEqual(['n: must be <= 10']);
    expect(checkTopLevelTypes(schema, { n: '-1' })).toEqual(['n: must be >= 0']);
    expect(checkTopLevelTypes(schema, { n: 1, s: 'abcd' })[0]).toMatch(/at most 3/);
    expect(checkTopLevelTypes(schema, { n: 1, l: [1, 2, 3] })[0]).toMatch(/at most 2 items/);
    expect(checkTopLevelTypes(schema, { n: 1, injected: 'x' })).toEqual(['unknown argument(s): injected']);
    expect(checkTopLevelTypes(schema, { n: 5, s: 'ab', l: [1] })).toEqual([]);
  });
  it('allows unknown keys when the schema does not forbid them', () => {
    expect(checkTopLevelTypes({ type: 'object', properties: { n: { type: 'number' } } } as never, { n: 1, extra: true })).toEqual([]);
  });

  describe('through the executor', () => {
    let ctx: Awaited<ReturnType<typeof makeMercury>>;
    let seen: unknown;
    beforeAll(async () => {
      ctx = await makeMercury();
      ctx.m.users.register('root', 'password-123');
      ctx.m.tools.register({
        name: 'probe_r8', description: 'probe', toolset: 'core', risk: 'safe',
        parameters: { type: 'object', properties: { n: { type: 'number', maximum: 10 } }, required: ['n'], additionalProperties: false },
        execute: async (a: unknown) => { seen = a; return { content: 'ok' }; },
      } as never);
    });
    afterAll(() => ctx.close());
    const exec = (args: Record<string, unknown>) => {
      const eve = ctx.m.users.principalFor(ctx.m.users.findByUsername('root')!);
      return ctx.m.executor.execute({ id: `c${Math.random()}`, name: 'probe_r8', arguments: args } as never, directToolContext(ctx.m, eve, 'r8'), { untrustedSeen: false, userRequest: 't' } as never);
    };
    it('direct out-of-range args are refused before execution', async () => {
      seen = undefined;
      const r = await exec({ n: 999 });
      expect(r.ok).toBe(false);
      expect(r.result.content).toMatch(/must be <= 10/);
      expect(seen).toBeUndefined();
    });
    it('hook-rewritten args with extra keys are refused', async () => {
      seen = undefined;
      ctx.m.hooks.register('before_tool_call', 'r8test', async (p: { tool?: string }) => (p.tool === 'probe_r8' ? { args: { n: 1, injected: 'x' } } : {}));
      const r = await exec({ n: 2 });
      expect(r.ok).toBe(false);
      expect(r.result.content).toMatch(/Hook produced invalid arguments.*unknown argument/);
      expect(seen).toBeUndefined();
    });
  });
});

describe('R9 runaway tools that ignore cancellation', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  const release: Array<() => void> = [];
  let started = 0;
  beforeAll(async () => {
    ctx = await makeMercury();
    ctx.m.users.register('root', 'password-123');
    ctx.m.tools.register({
      name: 'stubborn', description: 'ignores abort', toolset: 'core', risk: 'safe', timeoutMs: 20,
      parameters: { type: 'object', properties: {} },
      execute: () => { started++; return new Promise((r) => release.push(() => r({ content: 'late' }))); },
    } as never);
    ctx.m.tools.register({
      name: 'polite', description: 'honours abort', toolset: 'core', risk: 'safe', timeoutMs: 20,
      parameters: { type: 'object', properties: {} },
      execute: (_a: unknown, c: { signal?: AbortSignal }) => new Promise((_r, rej) => c.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    } as never);
  });
  afterAll(() => ctx.close());
  const exec = (name: string) => {
    const root = ctx.m.users.principalFor(ctx.m.users.findByUsername('root')!);
    return ctx.m.executor.execute({ id: `c${Math.random()}`, name, arguments: {} } as never, directToolContext(ctx.m, root, 'r9'), { untrustedSeen: false, userRequest: 't' } as never);
  };

  it('a tool that honours abort is not counted as runaway', async () => {
    const r = await exec('polite');
    expect(r.ok).toBe(false);
    await new Promise((r2) => setTimeout(r2, 5));
    expect(ctx.m.executor.runawayCount('polite')).toBe(0);
  });

  it('timed-out executions that keep running are tracked, emitted and block further calls at the limit', async () => {
    const events: unknown[] = [];
    ctx.m.bus.on('tool.runaway', (e: unknown) => events.push(e));
    for (let i = 0; i < ToolExecutor.MAX_RUNAWAY_PER_TOOL; i++) {
      const r = await exec('stubborn');
      expect(r.result.content).toMatch(/timed out/);
    }
    expect(ctx.m.executor.runawayCount('stubborn')).toBe(ToolExecutor.MAX_RUNAWAY_PER_TOOL);
    expect(events.length).toBe(ToolExecutor.MAX_RUNAWAY_PER_TOOL);
    const before = started;
    const blocked = await exec('stubborn');
    expect(blocked.ok).toBe(false);
    expect(blocked.result.content).toMatch(/still running past their timeout/);
    expect(started).toBe(before); // never invoked
  });

  it('once the runaway executions settle, the tool is usable again', async () => {
    release.splice(0).forEach((f) => f());
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.m.executor.runawayCount('stubborn')).toBe(0);
    const p = exec('stubborn');
    expect((await p).result.content).toMatch(/timed out/);
    release.splice(0).forEach((f) => f());
  });
});
