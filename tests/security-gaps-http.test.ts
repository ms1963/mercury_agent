/**
 * Regression tests for the HTTP-level security fixes on the `gaps` branch: run/approval/
 * schedule/task ownership, admin-only pairing, password change + JWT revocation, login lockout,
 * hardened headers, /metrics gating and API-token expiry. Uses Fastify inject (no network).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '@mercury/server';
import { makeMercury } from './helpers.js';

// Read the release version from the root package.json so this assertion tracks
// version bumps automatically instead of hard-coding a literal that breaks CI.
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version as string;

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let app: FastifyInstance;
let adminToken = '';
let aliceToken = '';
let bobToken = '';
let aliceId = '';
let bobId = '';
let aliceRun = '';

type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
const call = (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never });

const PW = 'correct-horse-1';

beforeAll(async () => {
  ctx = await makeMercury({ observability: { metricsToken: 'metrics-secret-123' } });
  app = await createServer(ctx.m);
  adminToken = (await call('POST', '/api/auth/register', undefined, { username: 'root', password: PW })).json().token;
  const a = (await call('POST', '/api/auth/register', undefined, { username: 'alice', password: PW })).json();
  aliceToken = a.token;
  aliceId = a.user.id;
  const b = (await call('POST', '/api/auth/register', undefined, { username: 'bob', password: PW })).json();
  bobToken = b.token;
  bobId = b.user.id;
  await call('POST', '/api/chat', aliceToken, { message: 'hello from alice' });
  aliceRun = ctx.m.db.get<{ id: string }>('SELECT id FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1', aliceId)!.id;
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('run ownership', () => {
  it('records the run for its owner', () => {
    expect(aliceRun).toMatch(/\w/);
  });
  it('lets the owner read run events and trace; hides them from other users (404)', async () => {
    expect((await call('GET', `/api/runs/${aliceRun}/events`, aliceToken)).statusCode).toBe(200);
    expect((await call('GET', `/api/runs/${aliceRun}/events`, bobToken)).statusCode).toBe(404);
    expect((await call('GET', `/api/runs/${aliceRun}/trace`, bobToken)).statusCode).toBe(404);
  });
  it('admins can read any run', async () => {
    expect((await call('GET', `/api/runs/${aliceRun}/events`, adminToken)).statusCode).toBe(200);
  });
  it('rejects feedback on another user\'s run', async () => {
    expect((await call('POST', `/api/runs/${aliceRun}/feedback`, bobToken, { positive: true })).statusCode).toBe(404);
    expect((await call('POST', `/api/runs/${aliceRun}/feedback`, aliceToken, { positive: true })).statusCode).toBe(200);
  });
  it('rejects time-travel, state and replay of another user\'s run', async () => {
    for (const [m, u] of [['GET', 'timetravel'], ['GET', 'state'], ['POST', 'replay']] as const) {
      const r = await call(m, `/api/runs/${aliceRun}/${u}`, bobToken, m === 'POST' ? {} : undefined);
      expect(r.statusCode, u).toBe(404);
    }
  });
  it('stop by another user does not stop the run', async () => {
    expect((await call('POST', `/api/runs/${aliceRun}/stop`, bobToken)).json().stopped).toBeFalsy();
  });
  it('debug resume of a step the caller does not own is 404', async () => {
    expect((await call('POST', '/api/debug/resume/nope', bobToken, {})).statusCode).toBe(404);
    expect((await call('GET', '/api/debug', bobToken)).json().paused).toEqual([]);
  });
  it('task budgets of other users are hidden', async () => {
    const r = await call('GET', '/api/tasks', bobToken);
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(aliceRun);
    expect((await call('GET', `/api/tasks/${aliceRun}`, bobToken)).statusCode).toBe(404);
  });
  it('verify: non-admins cannot run test/assertion checks or attach to foreign runs', async () => {
    expect((await call('POST', '/api/verify', bobToken, { output: 'x', checks: [{ type: 'test', command: 'true' }] })).statusCode).toBe(403);
    expect((await call('POST', '/api/verify', bobToken, { output: 'x', runId: aliceRun, checks: [] })).statusCode).toBe(404);
  });
});

describe('approvals', () => {
  it('only the requesting user or an admin may resolve; requireAdmin needs an admin', async () => {
    const tool = { title: 't', detail: 'd', risk: 'moderate' as const, tool: 'terminal', args: {} };
    const p1 = ctx.m.approvals.request(tool, { userId: aliceId, platform: 'web' });
    const id1 = ctx.m.approvals.list(aliceId)[0]!.id;
    expect((await call('GET', '/api/approvals', bobToken)).json().approvals).toEqual([]);
    expect((await call('POST', `/api/approvals/${id1}`, bobToken, { approved: true })).json().ok).toBe(false);
    expect((await call('POST', `/api/approvals/${id1}`, aliceToken, { approved: true })).json().ok).toBe(true);
    expect(await p1).toBe(true);

    const p2 = ctx.m.approvals.request({ ...tool, requireAdmin: true }, { userId: aliceId, platform: 'web' });
    const id2 = ctx.m.approvals.list(aliceId)[0]!.id;
    expect((await call('POST', `/api/approvals/${id2}`, aliceToken, { approved: true })).json().ok).toBe(false);
    expect((await call('POST', `/api/approvals/${id2}`, adminToken, { approved: false })).json().ok).toBe(true);
    expect(await p2).toBe(false);
  });
});

describe('schedules', () => {
  it('reserves __name__ schedules for admins', async () => {
    const r = await call('POST', '/api/schedules', aliceToken, { name: '__proactive_digest__', when: '0 * * * *', task: 'x' });
    expect(r.statusCode).toBe(403);
    const r2 = await call('POST', '/api/schedules', aliceToken, { name: 'mine', when: '0 * * * *', task: '__proactive_digest__' });
    expect(r2.statusCode).toBe(403);
  });
  it('rejects a schedule without when/task with 400 instead of a 500', async () => {
    expect((await call('POST', '/api/schedules', aliceToken, { name: 'x', task: 'y' })).statusCode).toBe(400);
  });
  it('hides a schedule history from other users', async () => {
    const s = await call('POST', '/api/schedules', aliceToken, { name: 'alice-job', when: '0 3 * * *', task: 'say hi' });
    expect(s.statusCode).toBe(200);
    const id = s.json().id ?? s.json().schedule?.id;
    expect(id).toBeTruthy();
    expect((await call('GET', `/api/schedules/${id}/history`, bobToken)).statusCode).toBe(404);
    expect((await call('GET', `/api/schedules/${id}/history`, aliceToken)).statusCode).toBe(200);
  });
});

describe('pairing', () => {
  it('requires an admin to approve a pairing code', async () => {
    const req = ctx.m.pairing.request('telegram', 'ext-1', 'chat-1', 'Mallory');
    expect((await call('POST', `/api/gateway/pair/${req.code}`, aliceToken, {})).statusCode).toBe(403);
    expect((await call('POST', `/api/gateway/pair/${req.code}`, adminToken, { userId: aliceId })).statusCode).toBe(200);
  });
  it('refuses to silently re-link an identity linked to another user (409)', async () => {
    const req = ctx.m.pairing.request('telegram', 'ext-1', 'chat-1', 'Mallory');
    expect((await call('POST', `/api/gateway/pair/${req.code}`, adminToken, { userId: bobId })).statusCode).toBe(409);
  });
});

describe('accounts and tokens', () => {
  it('password change needs the current password and revokes the old JWT', async () => {
    const u = (await call('POST', '/api/auth/register', undefined, { username: 'carol', password: PW })).json();
    expect((await call('PATCH', '/api/auth/me', u.token, { password: 'new-password-9' })).statusCode).toBe(403);
    expect((await call('PATCH', '/api/auth/me', u.token, { password: 'new-password-9', currentPassword: 'wrong-one' })).statusCode).toBe(403);
    const ok = await call('PATCH', '/api/auth/me', u.token, { password: 'new-password-9', currentPassword: PW });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    expect((await call('GET', '/api/auth/me', u.token)).statusCode).toBe(401);
    expect((await call('GET', '/api/auth/me', ok.json().token)).statusCode).toBe(200);
  });
  it('disabling a user revokes their existing JWT', async () => {
    const u = (await call('POST', '/api/auth/register', undefined, { username: 'dave', password: PW })).json();
    expect((await call('GET', '/api/auth/me', u.token)).statusCode).toBe(200);
    expect((await call('PATCH', `/api/users/${u.user.id}`, adminToken, { disabled: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', u.token)).statusCode).toBe(401);
  });
  it('the last admin cannot be demoted', async () => {
    const me = (await call('GET', '/api/auth/me', adminToken)).json();
    const id = me.id ?? me.user?.id;
    expect((await call('PATCH', `/api/users/${id}`, adminToken, { role: 'user' })).statusCode).toBe(409);
  });
  it('API tokens get a default expiry (auth.apiTokenMaxTtlDays)', async () => {
    const r = await call('POST', '/api/tokens', aliceToken, { name: 'ci', scopes: ['chat'] });
    expect(r.statusCode).toBe(200);
    const list = (await call('GET', '/api/tokens', aliceToken)).json().tokens as Array<{ expiresAt?: string }>;
    expect(list.length).toBeGreaterThan(0);
    const exp = Date.parse(list[0]!.expiresAt ?? '');
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp).toBeLessThanOrEqual(Date.now() + 366 * 86_400_000);
  });
  it('locks an account after 10 failed logins (429) without affecting others', async () => {
    await call('POST', '/api/auth/register', undefined, { username: 'erin', password: PW });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call('POST', '/api/auth/login', undefined, { username: 'erin', password: 'bad-password' })).statusCode;
    expect(last).toBe(429);
    expect((await call('POST', '/api/auth/login', undefined, { username: 'erin', password: PW })).statusCode).toBe(429);
    expect((await call('POST', '/api/auth/login', undefined, { username: 'alice', password: PW })).statusCode).toBe(200);
  });
  it('accepts ?token= only on the SSE events endpoint', async () => {
    expect((await call('GET', `/api/sessions?token=${aliceToken}`)).statusCode).toBe(401);
  });
});

describe('HTTP hardening', () => {
  it('sets security headers and no-store on API responses', async () => {
    const r = await call('GET', '/api/auth/status');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBeTruthy();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const html = await call('GET', '/');
    expect(String(html.headers['content-security-policy'] ?? '')).toContain("default-src");
  });
  it('reports the real package version on /health', async () => {
    expect((await call('GET', '/health')).json().version).toBe(pkgVersion);
  });
  it('serves uploaded HTML attachments as downloads, not inline', async () => {
    const att = await ctx.m.attachments.save(aliceId, 'x.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    const r = await call('GET', `/api/attachments/${att.id}`, aliceToken);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-disposition'] ?? '')).toMatch(/^attachment/);
  });
});

describe('/metrics gating', () => {
  it('is reachable over direct loopback (inject) and with the metrics token', async () => {
    expect((await call('GET', '/metrics')).statusCode).toBe(200);
    expect((await call('GET', '/metrics', 'metrics-secret-123', undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(200);
  });
  it('refuses proxied anonymous and non-admin requests', async () => {
    expect((await call('GET', '/metrics', undefined, undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(401);
    expect((await call('GET', '/metrics', 'wrong-token', undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(401);
    expect((await call('GET', '/metrics', aliceToken, undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(401);
    expect((await call('GET', '/metrics', adminToken, undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(200);
  });
});
