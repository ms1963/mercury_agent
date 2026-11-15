/** Audit logging of authentication/authorization events, plus the filtered query API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
beforeAll(async () => (ctx = await makeMercury()));
afterAll(() => ctx.close());

/** Newest matching audit entry for an exact action, or undefined. */
const latest = (action: string) => ctx.m.audit.list(1000).find((e) => e.action === action);

describe('audit: authentication events', () => {
  it('records a successful login with the user id as actor', () => {
    const user = ctx.m.users.register('audit-alice', 'password-1'); // first user => admin
    ctx.m.users.login('audit-alice', 'password-1');
    const entry = latest('auth.login');
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe(user.id);
    expect(entry!.target).toBe('audit-alice');
    expect(JSON.parse(entry!.details!).role).toBe('admin');
  });

  it('records a failed login with a bad password (reason=bad_password)', () => {
    expect(() => ctx.m.users.login('audit-alice', 'nope')).toThrow();
    const entry = latest('auth.login_failed');
    expect(entry).toBeDefined();
    expect(entry!.target).toBe('audit-alice');
    expect(JSON.parse(entry!.details!).reason).toBe('bad_password');
  });

  it('records a failed login for an unknown user (reason=unknown_user)', () => {
    expect(() => ctx.m.users.login('ghost', 'whatever')).toThrow();
    const entry = latest('auth.login_failed');
    expect(entry!.actor).toBe('ghost');
    expect(JSON.parse(entry!.details!).reason).toBe('unknown_user');
  });

  it('records a failed login for a disabled account (reason=account_disabled)', () => {
    const u = ctx.m.users.register('audit-bob', 'password-2');
    ctx.m.users.update(u.id, { disabled: true });
    expect(() => ctx.m.users.login('audit-bob', 'password-2')).toThrow();
    const entry = latest('auth.login_failed');
    expect(entry!.actor).toBe(u.id);
    expect(JSON.parse(entry!.details!).reason).toBe('account_disabled');
  });

  it('never stores the attempted password in audit details', () => {
    expect(() => ctx.m.users.login('audit-alice', 'super-secret-pw')).toThrow();
    expect(ctx.m.audit.list(1000).some((e) => (e.details ?? '').includes('super-secret-pw'))).toBe(false);
  });
});

describe('audit: user lifecycle events', () => {
  it('records registration with the new user as actor by default', () => {
    const u = ctx.m.users.register('audit-carol', 'password-3');
    const entry = ctx.m.audit.list(1000).find((e) => e.action === 'user.register' && e.target === 'audit-carol');
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe(u.id);
    expect(JSON.parse(entry!.details!).userId).toBe(u.id);
    expect(JSON.parse(entry!.details!).role).toBe('user');
  });

  it('records the operator as actor when an admin creates a user (CLI/HTTP path)', () => {
    const admin = ctx.m.users.findByUsername('audit-alice')!;
    const u = ctx.m.users.register('audit-dave', 'password-4', { role: 'user' }, admin.id);
    const entry = ctx.m.audit.list(1000).find((e) => e.action === 'user.register' && e.target === 'audit-dave');
    expect(entry!.actor).toBe(admin.id);
    expect(u.username).toBe('audit-dave');
  });

  it('records a user update with only the changed fields and the operator', () => {
    const admin = ctx.m.users.findByUsername('audit-alice')!;
    const dave = ctx.m.users.findByUsername('audit-dave')!;
    ctx.m.users.update(dave.id, { role: 'admin' }, admin.id);
    const entry = ctx.m.audit.list(1000).find((e) => e.action === 'user.update' && e.target === dave.id);
    expect(entry!.actor).toBe(admin.id);
    const details = JSON.parse(entry!.details!);
    expect(details.role).toBe('admin');
    expect(details.disabled).toBeUndefined(); // untouched fields are not logged
  });

  it('records a user deletion with the operator and username', () => {
    const admin = ctx.m.users.findByUsername('audit-alice')!;
    const dave = ctx.m.users.findByUsername('audit-dave')!;
    ctx.m.users.delete(dave.id, admin.id);
    const entry = ctx.m.audit.list(1000).find((e) => e.action === 'user.delete' && e.target === dave.id);
    expect(entry!.actor).toBe(admin.id);
    expect(JSON.parse(entry!.details!).username).toBe('audit-dave');
  });
});

describe('audit: API token lifecycle', () => {
  it('records token issuance with scopes and owner', () => {
    const alice = ctx.m.users.findByUsername('audit-alice')!;
    const { info } = ctx.m.users.createToken(alice.id, 'ci-token', ['chat', 'mcp'], undefined, alice.id);
    const entry = latest('token.issue');
    expect(entry!.actor).toBe(alice.id);
    expect(entry!.target).toBe(info.id);
    const details = JSON.parse(entry!.details!);
    expect(details.scopes).toEqual(['chat', 'mcp']);
    expect(details.userId).toBe(alice.id);
  });

  it('records token revocation and does not double-log an already-revoked token', () => {
    const alice = ctx.m.users.findByUsername('audit-alice')!;
    const { info } = ctx.m.users.createToken(alice.id, 'temp', ['chat'], undefined, alice.id);
    ctx.m.users.revokeToken(info.id, alice.id);
    const entry = latest('token.revoke');
    expect(entry!.target).toBe(info.id);
    expect(entry!.actor).toBe(alice.id);
    const before = ctx.m.audit.query({ action: 'token.revoke' }).total;
    ctx.m.users.revokeToken(info.id, alice.id); // already revoked
    const after = ctx.m.audit.query({ action: 'token.revoke' }).total;
    expect(after).toBe(before);
  });
});

describe('audit: gateway pairing approvals', () => {
  it('records pairing approval with the linked identity and actor', () => {
    const alice = ctx.m.users.findByUsername('audit-alice')!;
    const req = ctx.m.pairing.request('telegram', 'tg-12345', 'chat-1', 'Telegram User');
    ctx.m.pairing.approve(req.code, alice.id, alice.id);
    const entry = latest('pairing.approve');
    expect(entry!.actor).toBe(alice.id);
    expect(entry!.target).toBe(req.code);
    const details = JSON.parse(entry!.details!);
    expect(details.platform).toBe('telegram');
    expect(details.externalId).toBe('tg-12345');
    expect(details.linkedUserId).toBe(alice.id);
  });

  it('records pairing rejection', () => {
    const req = ctx.m.pairing.request('slack', 'sl-999', 'chan-1', 'Slack User');
    ctx.m.pairing.reject(req.code, ctx.m.users.findByUsername('audit-alice')!.id);
    const entry = latest('pairing.reject');
    expect(entry!.target).toBe(req.code);
    expect(JSON.parse(entry!.details!).platform).toBe('slack');
  });
});

describe('audit: filtered query API', () => {
  it('matches an action prefix (token => token.issue + token.revoke)', () => {
    const { entries } = ctx.m.audit.query({ action: 'token' });
    const actions = new Set(entries.map((e) => e.action));
    expect(actions.has('token.issue')).toBe(true);
    expect(actions.has('token.revoke')).toBe(true);
    expect(entries.every((e) => e.action.startsWith('token'))).toBe(true);
  });

  it('matches an exact action', () => {
    const { entries } = ctx.m.audit.query({ action: 'auth.login' });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === 'auth.login')).toBe(true);
  });

  it('filters by actor', () => {
    const alice = ctx.m.users.findByUsername('audit-alice')!;
    const { entries } = ctx.m.audit.query({ actor: alice.id });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.actor === alice.id)).toBe(true);
  });

  it('paginates with limit/offset and reports the unfiltered total', () => {
    const all = ctx.m.audit.query({});
    const page = ctx.m.audit.query({ limit: 2, offset: 0 });
    expect(page.entries.length).toBe(2);
    expect(page.total).toBe(all.total);
    const next = ctx.m.audit.query({ limit: 2, offset: 2 });
    expect(next.entries[0]!.seq).toBeLessThan(page.entries[0]!.seq); // newest-first ordering
  });

  it('filters by time window (since)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(ctx.m.audit.query({ since: future }).entries.length).toBe(0);
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(ctx.m.audit.query({ since: past }).total).toBeGreaterThan(0);
  });

  it('clamps an out-of-range limit instead of failing', () => {
    expect(ctx.m.audit.query({ limit: 10_000 }).entries.length).toBeLessThanOrEqual(1000);
    expect(ctx.m.audit.query({ limit: -5 }).entries.length).toBeGreaterThanOrEqual(0);
  });
});

describe('audit: tamper-evident chain stays intact', () => {
  it('verifies after all auth/token/pairing appends', () => {
    const v = ctx.m.audit.verify();
    expect(v.ok).toBe(true);
    expect(v.brokenAt).toBeNull();
    expect(v.count).toBeGreaterThan(0);
  });
});
