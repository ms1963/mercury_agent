/**
 * User accounts, API tokens and chat-platform identities.
 * The first registered user becomes admin (bootstrap).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { MercuryError, NotFoundError, newId, nowIso, type Principal, type UserRole } from '../types/common.js';
import { generateApiToken, hashPassword, sha256, signJwt, verifyJwt, verifyPassword } from './crypto.js';
import type { UserPolicy } from './policy.js';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string;
  locale?: string;
  disabled: boolean;
  policy: UserPolicy;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revoked: boolean;
}

/** Known token scopes. `*` grants everything the owning user may do. */
export const SCOPES = ['chat', 'agent', 'workflow', 'memory', 'skills', 'tools', 'schedule', 'mcp', 'admin', 'read', '*'] as const;

type UserRow = { id: string; username: string; role: string; display_name: string | null; locale: string | null; disabled: number; policy: string | null; created_at: string; password_hash: string };

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  role: r.role as UserRole,
  displayName: r.display_name ?? undefined,
  locale: r.locale ?? undefined,
  disabled: !!r.disabled,
  policy: fromJson<UserPolicy>(r.policy, {}),
  createdAt: r.created_at,
});

export class UserService {
  readonly secret: string;

  constructor(private db: Db, dataDir: string, private tokenTtlHours = 168) {
    this.secret = loadOrCreateSecret(join(dataDir, 'secret.key'));
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  register(username: string, password: string, opts: { role?: UserRole; displayName?: string } = {}): User {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new MercuryError('Username must be 3-32 chars: letters, digits, _ . -', 'invalid_username', 'auth');
    if (password.length < 8) throw new MercuryError('Password must be at least 8 characters', 'weak_password', 'auth');
    if (this.findByUsername(username)) throw new MercuryError('Username already taken', 'username_taken', 'auth', 409);
    const role: UserRole = this.count() === 0 ? 'admin' : (opts.role ?? 'user');
    const id = newId('usr');
    this.db.run(
      'INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (?,?,?,?,?,?)',
      id, username, hashPassword(password), role, opts.displayName ?? username, nowIso(),
    );
    return this.get(id);
  }

  get(id: string): User {
    const r = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!r) throw new NotFoundError(`User not found: ${id}`);
    return toUser(r);
  }

  findByUsername(username: string): User | undefined {
    const r = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    return r ? toUser(r) : undefined;
  }

  /** Accepts a user id or username. */
  resolve(idOrName: string): User {
    return this.findByUsername(idOrName) ?? this.get(idOrName);
  }

  list(): User[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at').map(toUser);
  }

  update(id: string, patch: Partial<Pick<User, 'role' | 'displayName' | 'locale' | 'disabled' | 'policy'>>): User {
    const u = this.get(id);
    this.db.run(
      'UPDATE users SET role=?, display_name=?, locale=?, disabled=?, policy=? WHERE id=?',
      patch.role ?? u.role, patch.displayName ?? u.displayName, patch.locale ?? u.locale,
      patch.disabled ?? u.disabled, toJson(patch.policy ?? u.policy), id,
    );
    return this.get(id);
  }

  setPassword(id: string, password: string): void {
    if (password.length < 8) throw new MercuryError('Password must be at least 8 characters', 'weak_password', 'auth');
    this.db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM users WHERE id=?', id);
  }

  /** Verify credentials and issue a session JWT. */
  login(username: string, password: string): { token: string; user: User } {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!row || !verifyPassword(password, row.password_hash)) throw new MercuryError('Invalid username or password', 'invalid_credentials', 'auth', 401);
    if (row.disabled) throw new MercuryError('Account disabled', 'account_disabled', 'auth', 403);
    const user = toUser(row);
    return { token: this.issueJwt(user), user };
  }

  issueJwt(user: User): string {
    return signJwt({ sub: user.id, role: user.role, username: user.username }, this.secret, this.tokenTtlHours * 3600);
  }

  createToken(userId: string, name: string, scopes: string[] = ['*'], ttlDays?: number): { token: string; info: ApiToken } {
    const bad = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (bad.length) throw new MercuryError(`Unknown scopes: ${bad.join(', ')}`, 'invalid_scope', 'auth');
    const token = generateApiToken();
    const id = newId('tok');
    const expires = ttlDays ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;
    this.db.run('INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at) VALUES (?,?,?,?,?,?,?)', id, userId, name, sha256(token), toJson(scopes), nowIso(), expires);
    return { token, info: this.listTokens(userId).find((t) => t.id === id)! };
  }

  listTokens(userId?: string): ApiToken[] {
    const rows = userId
      ? this.db.all<Record<string, unknown>>('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at', userId)
      : this.db.all<Record<string, unknown>>('SELECT * FROM api_tokens ORDER BY created_at');
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.name ?? ''),
      scopes: fromJson<string[]>(r.scopes, []),
      createdAt: String(r.created_at),
      expiresAt: (r.expires_at as string) ?? undefined,
      lastUsedAt: (r.last_used_at as string) ?? undefined,
      revoked: !!r.revoked,
    }));
  }

  revokeToken(id: string): void {
    this.db.run('UPDATE api_tokens SET revoked = 1 WHERE id = ?', id);
  }

  /** Authenticate a bearer credential (JWT or API token) into a Principal. */
  authenticate(credential: string | undefined): Principal | null {
    if (!credential) return null;
    const raw = credential.replace(/^Bearer\s+/i, '').trim();
    if (raw.startsWith('mrc_')) {
      const row = this.db.get<Record<string, unknown>>('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0', sha256(raw));
      if (!row) return null;
      if (row.expires_at && String(row.expires_at) < nowIso()) return null;
      const user = this.get(String(row.user_id));
      if (user.disabled) return null;
      this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.id as string);
      return { userId: user.id, username: user.username, role: user.role, kind: 'api_client', scopes: fromJson<string[]>(row.scopes, []) };
    }
    const payload = verifyJwt(raw, this.secret);
    if (!payload) return null;
    try {
      const user = this.get(payload.sub);
      if (user.disabled) return null;
      return { userId: user.id, username: user.username, role: user.role, kind: 'user', scopes: ['*'] };
    } catch {
      return null;
    }
  }

  principalFor(user: User): Principal {
    return { userId: user.id, username: user.username, role: user.role, kind: 'user', scopes: ['*'] };
  }

  // ---- chat platform identities -------------------------------------------------
  linkIdentity(platform: string, externalId: string, userId: string, displayName?: string): void {
    this.db.run('INSERT OR REPLACE INTO identities (platform, external_id, user_id, display_name, created_at) VALUES (?,?,?,?,?)', platform, externalId, userId, displayName, nowIso());
  }

  findIdentity(platform: string, externalId: string): User | undefined {
    const r = this.db.get<{ user_id: string }>('SELECT user_id FROM identities WHERE platform = ? AND external_id = ?', platform, externalId);
    return r ? this.get(r.user_id) : undefined;
  }

  listIdentities(userId: string): Array<{ platform: string; externalId: string; displayName?: string }> {
    return this.db
      .all<{ platform: string; external_id: string; display_name: string | null }>('SELECT * FROM identities WHERE user_id = ?', userId)
      .map((r) => ({ platform: r.platform, externalId: r.external_id, displayName: r.display_name ?? undefined }));
  }
}

function loadOrCreateSecret(file: string): string {
  if (process.env.MERCURY_JWT_SECRET) return process.env.MERCURY_JWT_SECRET;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
