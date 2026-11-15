/** HTTP API smoke test via Fastify inject: auth, chat (JSON + SSE), RBAC, MCP endpoint, metrics, static UI. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '@mercury/server';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let app: FastifyInstance;
let adminToken = '';
let userToken = '';

const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });

beforeAll(async () => {
  ctx = await makeMercury();
  app = await createServer(ctx.m);
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('server', () => {
  it('serves health and the web UI', async () => {
    expect((await call('GET', '/health')).json()).toMatchObject({ ok: true });
    const html = await call('GET', '/');
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('<title>Mercury</title>');
    expect((await call('GET', '/js/app.js')).headers['content-type']).toContain('javascript');
  });

  it('registers the first user as admin, the second as user', async () => {
    expect((await call('GET', '/api/auth/status')).json()).toMatchObject({ users: 0 });
    const a = (await call('POST', '/api/auth/register', undefined, { username: 'root', password: 'pw-123456' })).json();
    expect(a.user.role).toBe('admin');
    adminToken = a.token;
    const u = (await call('POST', '/api/auth/register', undefined, { username: 'eve', password: 'pw-654321' })).json();
    expect(u.user.role).toBe('user');
    userToken = (await call('POST', '/api/auth/login', undefined, { username: 'eve', password: 'pw-654321' })).json().token;
    expect((await call('POST', '/api/auth/login', undefined, { username: 'eve', password: 'nope' })).statusCode).toBe(401);
  });

  it('enforces authentication and admin-only routes', async () => {
    expect((await call('GET', '/api/sessions')).statusCode).toBe(401);
    expect((await call('GET', '/api/users', userToken)).statusCode).toBe(403);
    expect((await call('GET', '/api/users', adminToken)).json().users.length).toBe(2);
  });

  it('chats (JSON and SSE stream)', async () => {
    const r = (await call('POST', '/api/chat', userToken, { message: 'hi server' })).json();
    expect(r.output).toContain('Echo: hi server');
    const s = await call('POST', '/api/chat', userToken, { message: 'call:calculator {"expression":"40+2"}', stream: true, sessionId: r.sessionId });
    expect(s.headers['content-type']).toContain('text/event-stream');
    expect(s.body).toContain('event: delta');
    expect(s.body).toContain('"type":"tool.call"');
    expect(s.body).toMatch(/event: done\ndata: .*42/);
    const sessions = (await call('GET', '/api/sessions', userToken)).json().sessions;
    expect(sessions.length).toBe(1);
    const detail = (await call('GET', `/api/sessions/${r.sessionId}`, userToken)).json();
    expect(detail.messages.length).toBeGreaterThanOrEqual(4);
    expect((await call('GET', `/api/sessions/${r.sessionId}`, adminToken)).statusCode).toBe(404);
  });

  it('uploads attachments and lists management data', async () => {
    const up = await app.inject({ method: 'POST', url: '/api/attachments?name=note.txt', headers: { authorization: `Bearer ${userToken}`, 'content-type': 'text/plain' }, payload: 'hello file' });
    expect(up.json().id).toBeTruthy();
    for (const url of ['/api/tools', '/api/skills', '/api/memory', '/api/workflows', '/api/schedules', '/api/models', '/api/budgets', '/api/reflections', '/api/decisions', '/api/runs', '/api/gateway', '/api/help', '/api/i18n/de']) {
      expect((await call('GET', url, userToken)).statusCode, url).toBe(200);
    }
    expect((await call('GET', '/api/i18n', userToken)).json().locales).toEqual(expect.arrayContaining(['en', 'de']));
  });

  it('exposes the MCP endpoint only to tokens with the mcp scope', async () => {
    const chatOnly = (await call('POST', '/api/tokens', adminToken, { name: 'chat', scopes: ['chat'] })).json().token;
    const mcp = (await call('POST', '/api/tokens', adminToken, { name: 'mcp', scopes: ['mcp'] })).json().token;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const headers = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: headers(chatOnly), payload: init })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/mcp', headers: headers(mcp), payload: init });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('serverInfo');
  });

  it('exposes the audit log to admins only, with filtering', async () => {
    expect((await call('GET', '/api/audit', userToken)).statusCode).toBe(403);
    const all = await call('GET', '/api/audit', adminToken);
    expect(all.statusCode).toBe(200);
    expect(Array.isArray(all.json().entries)).toBe(true);
    expect(all.json().integrity.ok).toBe(true);
    // Token issuance earlier in this suite must be audited and filterable by action prefix.
    const tokens = (await call('GET', '/api/audit?action=token', adminToken)).json();
    expect(tokens.entries.length).toBeGreaterThan(0);
    expect(tokens.entries.every((e: { action: string }) => e.action.startsWith('token'))).toBe(true);
    expect(typeof tokens.total).toBe('number');
    // The earlier bad login for 'eve' must be recorded as a failure.
    const fails = (await call('GET', '/api/audit?action=auth.login_failed', adminToken)).json();
    expect(fails.entries.length).toBeGreaterThan(0);
    expect(fails.entries.every((e: { action: string }) => e.action === 'auth.login_failed')).toBe(true);
  });

  it('publishes Prometheus metrics', async () => {
    const r = await call('GET', '/metrics');
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/# TYPE \w+/);
  });
});
