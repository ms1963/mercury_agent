/** Core agent loop with the mock LLM: chat, tool calls, sessions, slash commands, streaming, events. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@mercury/core';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let p: Principal;

beforeAll(async () => {
  ctx = await makeMercury();
  p = await ctx.m.localPrincipal();
});
afterAll(() => ctx.close());

describe('agent loop (mock LLM)', () => {
  it('answers a plain message and persists the session', async () => {
    const r = await ctx.m.commands.handle({ principal: p, input: 'Hello there', platform: 'cli' });
    expect(r.output).toContain('Echo: Hello there');
    expect(r.run?.status).toBe('completed');
    const rows = ctx.m.db.all<{ role: string }>('SELECT role FROM messages WHERE session_id = ? ORDER BY seq', r.sessionId);
    expect(rows.map((x) => x.role)).toEqual(expect.arrayContaining(['user', 'assistant']));
  });

  it('executes a tool call and feeds the result back', async () => {
    const r = await ctx.m.commands.handle({ principal: p, input: 'call:calculator {"expression":"2*21"}', platform: 'cli' });
    expect(r.run?.toolNames).toContain('calculator');
    expect(r.output).toContain('42');
  });

  it('streams deltas and emits run events', async () => {
    const types: string[] = [];
    const off = ctx.m.bus.on('*', (e) => void types.push(e.type));
    let streamed = '';
    const r = await ctx.m.commands.handle({ principal: p, input: 'stream me', platform: 'web', onDelta: (t) => (streamed += t) });
    off();
    expect(streamed.trim()).toBe(r.output.trim());
    expect(types).toEqual(expect.arrayContaining(['run.start', 'run.end']));
    expect(ctx.m.recorder.replay(r.run!.runId).length).toBeGreaterThan(0);
  });

  it('supports slash commands (/new, /usage, /undo, /help)', async () => {
    const first = await ctx.m.commands.handle({ principal: p, input: 'remember this turn', platform: 'cli' });
    const usage = await ctx.m.commands.handle({ principal: p, input: '/usage', platform: 'cli', sessionId: first.sessionId });
    expect(usage.command).toBe('usage');
    const undo = await ctx.m.commands.handle({ principal: p, input: '/undo', platform: 'cli', sessionId: first.sessionId });
    expect(undo.command).toBe('undo');
    const fresh = await ctx.m.commands.handle({ principal: p, input: '/new', platform: 'cli', sessionId: first.sessionId });
    expect(fresh.sessionId).not.toBe(first.sessionId);
    const help = await ctx.m.commands.handle({ principal: p, input: '/help', platform: 'cli' });
    expect(help.output).toMatch(/\/model/);
  });

  it('continues a conversation in the same session', async () => {
    const a = await ctx.m.commands.handle({ principal: p, input: 'first', platform: 'cli' });
    const b = await ctx.m.commands.handle({ principal: p, input: 'second', platform: 'cli', sessionId: a.sessionId });
    expect(b.sessionId).toBe(a.sessionId);
    const n = ctx.m.db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role = 'user'", a.sessionId);
    expect(n?.n).toBe(2);
  });
});
