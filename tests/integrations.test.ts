/** Jev provider (mocked HTTP), decision fallback, MCP roundtrip, adapters with MockTransport, gateway pairing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JevDecisionProvider, MockDecisionProvider, hmacHex, createLogger, type Principal } from '@mercury/core';
import { MockTransport, TelegramAdapter, SlackAdapter, type InboundMessage } from '@mercury/gateway';
import { createMcpServer } from '@mercury/mcp';
import { makeMercury } from './helpers.js';

const QUESTIONS = { route: { type: 'choice' as const, instructions: 'Pick a tier', criteria: { small: 'easy', large: 'hard' } } };

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    const r = responses.shift()!;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('Jev decision provider', () => {
  it('posts questions to the decisions API and parses answers', async () => {
    const f = fakeFetch([{ status: 200, body: { model: 'typesafe/jev-1.13', answers: { route: { type: 'choice', choice: 'large', confidence: 0.91 } }, usage: { cost: 0.0001 } } }]);
    const jev = new JevDecisionProvider({ apiKey: 'k', fetchImpl: f.impl });
    const r = await jev.decide({ state: 'Prove the Riemann hypothesis', questions: QUESTIONS });
    expect(r.answers.route).toMatchObject({ choice: 'large' });
    expect(r.provider).toBe('jev');
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(f.calls[0]!.auth).toBe('Bearer k');
    expect(f.calls[0]!.body).toMatchObject({ model: 'typesafe/jev-1.13', questions: QUESTIONS });
  });

  it('retries transient errors and fails fast on client errors', async () => {
    const ok = { status: 200, body: { answers: { route: { type: 'choice', choice: 'small' } } } };
    const retry = fakeFetch([{ status: 429, body: 'slow down', headers: { 'retry-after': '0.01' } }, ok]);
    await expect(new JevDecisionProvider({ apiKey: 'k', fetchImpl: retry.impl }).decide({ state: 's', questions: QUESTIONS })).resolves.toBeDefined();
    expect(retry.calls.length).toBe(2);
    const bad = fakeFetch([{ status: 400, body: 'bad request' }]);
    await expect(new JevDecisionProvider({ apiKey: 'k', fetchImpl: bad.impl }).decide({ state: 's', questions: QUESTIONS })).rejects.toThrow(/400/);
    expect(bad.calls.length).toBe(1);
    expect(new JevDecisionProvider({}).available()).toBe(false);
  });
});

describe('with a Mercury instance', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let admin: Principal;
  const transport = new MockTransport();
  beforeAll(async () => {
    ctx = await makeMercury({ gateway: { triage: false, pairing: true } }, { transport });
    admin = await ctx.m.localPrincipal();
  });
  afterAll(() => ctx.close());

  it('decision engine falls back from a failing Jev to the next provider', async () => {
    const failing = new JevDecisionProvider({ apiKey: 'k', fetchImpl: fakeFetch([{ status: 401, body: 'nope' }]).impl });
    const before = ctx.m.decisions.chain();
    ctx.m.decisions.setProviders([failing, new MockDecisionProvider()]);
    const r = await ctx.m.decisions.decide({ state: 'x', questions: QUESTIONS, purpose: 'test' });
    expect(r.provider).toBe('mock');
    expect(['small', 'large']).toContain((r.answers.route as { choice: string }).choice);
    expect(before).toEqual(['mock']);
  });

  it('MCP roundtrip: lists and calls Mercury tools through the MCP server', async () => {
    const server = createMcpServer(ctx.m.mcpBackend(), { ...admin, scopes: ['mcp', 'tools'] } as Principal);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'mercury_calculator')).toBe(true);
    const res = await client.callTool({ name: 'mercury_calculator', arguments: { expression: '6*7' } });
    expect(JSON.stringify(res.content)).toContain('42');
    await client.close();
  });

  it('gateway: unknown users get a pairing code; after pairing the conversation continues', async () => {
    const body = (text: string) => JSON.stringify({ user: 'ext-42', text });
    const send = (text: string) => ctx.m.gateway.handleWebhook('hook', { method: 'POST', url: '/webhooks/hook', headers: { 'x-mercury-signature': `sha256=${hmacHex('s3cret', body(text))}` }, query: {}, body: body(text) });
    await ctx.m.gateway.add('hook', { type: 'webhook', secret: 's3cret', sync: true, timeoutMs: 20_000 });

    const bad = await ctx.m.gateway.handleWebhook('hook', { method: 'POST', url: '/', headers: { 'x-mercury-signature': 'sha256=00' }, query: {}, body: body('hi') });
    expect(bad.status).toBe(401);

    const first = await send('hello');
    const code = /pairing code is (\w+)/.exec(JSON.stringify(first.body))?.[1];
    expect(code).toBeTruthy();
    ctx.m.pairing.approve(code!, admin.userId);
    expect(ctx.m.users.findIdentity('hook', 'ext-42')?.id).toBe(admin.userId);

    const second = await send('ping one');
    expect(JSON.stringify(second.body)).toContain('Echo: ping one');
    await send('ping two');
    const sessions = ctx.m.db.all<{ n: number }>("SELECT COUNT(DISTINCT session_id) n FROM messages WHERE content LIKE 'ping %'");
    expect(sessions[0]!.n).toBe(1);
  });

  it('telegram adapter: polls updates, transcribes voice memos and replies via MockTransport', async () => {
    let armed = false;
    transport
      .on('/getMe', { body: { ok: true, result: { username: 'bot' } } })
      .on('/getUpdates', () => (armed ? ((armed = false), { body: { ok: true, result: [{ update_id: 7, message: { message_id: 1, chat: { id: 99, type: 'private' }, from: { id: 99, username: 'dana' }, voice: { file_id: 'F1', mime_type: 'audio/ogg' } } }] } }) : { status: 503, body: 'down' }))
      .on('/getFile', { body: { ok: true, result: { file_path: 'voice/1.ogg' } } })
      .on('/file/bot', { body: 'OGGDATA' });
    const inbound: InboundMessage[] = [];
    const tg = new TelegramAdapter('telegram', { token: 'T', apiBase: 'http://tg.test' }, { transport, logger: createLogger('error') });
    await tg.start(async (m) => void inbound.push(m));
    armed = true;
    await tg.pollOnce();
    await tg.stop();
    expect(inbound[0]).toMatchObject({ platform: 'telegram', userId: '99', chatId: '99' });
    expect(inbound[0]!.attachments?.[0]).toMatchObject({ voice: true });
    await tg.send({ chatId: '99', text: 'hi dana' });
    expect(JSON.parse(transport.last('/sendMessage')!.body!)).toMatchObject({ chat_id: '99', text: 'hi dana' });

    // Through the gateway: voice memo → transcript → agent turn.
    ctx.m.users.linkIdentity('tg', '99', admin.userId);
    const sent: string[] = [];
    await ctx.m.gateway.add('tg', { type: 'telegram' }, { name: 'tg', type: 'telegram', textOnly: false, start: async () => undefined, stop: async () => undefined, status: () => ({ connected: true }), send: async (o) => void sent.push(o.text) } as never);
    await ctx.m.gateway.onInbound({ ...inbound[0]!, platform: 'tg', attachments: [{ name: 'v.ogg', mime: 'audio/ogg', data: Buffer.from('x'), voice: true }] });
    expect(sent.join('\n')).toContain('[voice memo]');
  });

  it('slack adapter rejects requests with a bad signature', async () => {
    const slack = new SlackAdapter('slack', { token: 'xoxb-test', signingSecret: 'sig' }, { transport, logger: createLogger('error') });
    const res = await slack.handleWebhook({ method: 'POST', url: '/webhooks/slack', headers: { 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': 'v0=bad' }, query: {}, body: '{}' });
    expect(res.status).toBe(401);
  });
});
