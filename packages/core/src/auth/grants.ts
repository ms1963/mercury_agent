/**
 * Least-privilege capability broker with time-limited grants (no standing keys).
 *
 * The agent holds NO standing credentials. To perform a sensitive action the execution
 * path must first be issued a scoped, time-limited {@link Grant} for the required
 * capability; without a live grant the action is denied ({@link GrantDeniedError}). Grants
 * are per-task, expire after a TTL, may be use-capped and can be revoked at any time.
 *
 * Ephemeral credentials (e.g. a short-lived API token for one task) are minted against a
 * grant and kept ONLY in memory for the grant's lifetime — they are never persisted to the
 * database, config or disk, and vanish the instant the grant expires or is revoked. This is
 * real runtime state, not a mock.
 *
 * A pluggable clock (`now`) makes expiry deterministic in tests.
 */
import { randomBytes } from 'node:crypto';
import type { MercuryConfig } from '../config/schema.js';
import type { EventBus } from '../events/bus.js';
import type { AuditLog } from '../security/audit.js';
import { GrantDeniedError, newId } from '../types/common.js';

export interface GrantRequest {
  /** The capability being granted, e.g. 'payment.charge', 'email.send', 'secret.read'. */
  capability: string;
  /** Task/run the grant is bound to; the grant is only valid for this task. */
  taskId: string;
  /** Optional narrower scope (glob), e.g. 'acme.com' for email, 'customer:42' for a charge. */
  scope?: string;
  /** Who/what authorized the grant (user, policy, approval id). */
  grantedBy?: string;
  /** Requested lifetime in ms (clamped to `security.grants.maxTtlMs`). */
  ttlMs?: number;
  /** Optional cap on how many times the grant may be used. */
  maxUses?: number;
}

export interface Grant {
  id: string;
  capability: string;
  taskId: string;
  scope?: string;
  grantedBy: string;
  grantedAt: string;
  /** Epoch ms after which the grant is invalid. */
  expiresAt: number;
  uses: number;
  maxUses?: number;
  revoked: boolean;
}

export interface EphemeralCredential {
  /** Opaque handle the execution path passes around in place of the real secret. */
  handle: string;
  grantId: string;
  expiresAt: number;
}

/** Match a scope pattern (supports a trailing/embedded `*` glob) against a concrete value. */
function scopeMatches(pattern: string | undefined, value: string | undefined): boolean {
  if (!pattern || pattern === '*') return true;
  if (value === undefined) return false;
  if (!pattern.includes('*')) return pattern === value;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

export class GrantBroker {
  private grants = new Map<string, Grant>();
  /** handle -> { grantId, secret } — in-memory only, never persisted. */
  private credentials = new Map<string, { grantId: string; secret: string }>();

  constructor(
    private config: MercuryConfig,
    private bus?: EventBus,
    private audit?: AuditLog,
    private now: () => number = () => Date.now(),
  ) {}

  private get cfg() {
    return this.config.security.grants;
  }

  /** Issue a scoped, time-limited grant for a task. TTL is clamped to the configured maximum. */
  issue(req: GrantRequest): Grant {
    const ttl = Math.min(req.ttlMs ?? this.cfg.defaultTtlMs, this.cfg.maxTtlMs);
    const now = this.now();
    const grant: Grant = {
      id: newId('grant'),
      capability: req.capability,
      taskId: req.taskId,
      scope: req.scope,
      grantedBy: req.grantedBy ?? 'system',
      grantedAt: new Date(now).toISOString(),
      expiresAt: now + ttl,
      uses: 0,
      maxUses: req.maxUses,
      revoked: false,
    };
    this.grants.set(grant.id, grant);
    this.audit?.record(grant.grantedBy, 'grant.issue', grant.capability, { grantId: grant.id, taskId: grant.taskId, scope: grant.scope, ttlMs: ttl, maxUses: grant.maxUses });
    this.bus?.emit({ type: 'grant.issued', runId: grant.taskId, data: { grantId: grant.id, capability: grant.capability, scope: grant.scope, expiresAt: grant.expiresAt } });
    return grant;
  }

  /** Is a grant currently valid (not expired, not revoked, uses remaining)? */
  private valid(g: Grant): boolean {
    if (g.revoked) return false;
    if (this.now() >= g.expiresAt) return false;
    if (g.maxUses !== undefined && g.uses >= g.maxUses) return false;
    return true;
  }

  /**
   * Find a live grant satisfying a capability (+ optional scope) for a task. Returns the
   * grant without consuming a use. Returns undefined when none matches. When grants are
   * disabled in config, every check passes (returns a synthetic always-valid sentinel: use
   * {@link assert}, which short-circuits, rather than relying on this).
   */
  find(taskId: string, capability: string, scope?: string): Grant | undefined {
    for (const g of this.grants.values()) {
      if (g.taskId === taskId && g.capability === capability && this.valid(g) && scopeMatches(g.scope, scope)) return g;
    }
    return undefined;
  }

  /** True if a live grant exists for the capability/scope on the task (no use consumed). */
  check(taskId: string, capability: string, scope?: string): boolean {
    if (!this.cfg.enabled) return true;
    return !!this.find(taskId, capability, scope);
  }

  /**
   * Assert a live grant exists and CONSUME one use; throws {@link GrantDeniedError} otherwise.
   * No-op (always allowed) when grants are disabled in config.
   */
  assert(taskId: string, capability: string, scope?: string): Grant | undefined {
    if (!this.cfg.enabled) return undefined;
    const g = this.find(taskId, capability, scope);
    if (!g) {
      this.audit?.record('system', 'grant.denied', capability, { taskId, scope });
      this.bus?.emit({ type: 'grant.denied', runId: taskId, data: { capability, scope } });
      throw new GrantDeniedError(`No valid grant for capability "${capability}"${scope ? ` (scope: ${scope})` : ''} on this task. A scoped, time-limited grant must be issued first.`);
    }
    g.uses += 1;
    this.bus?.emit({ type: 'grant.used', runId: taskId, data: { grantId: g.id, capability, scope, uses: g.uses } });
    return g;
  }

  /** Revoke a single grant by id (and drop any credentials minted from it). Returns true if found. */
  revoke(grantId: string, by = 'system'): boolean {
    const g = this.grants.get(grantId);
    if (!g || g.revoked) return false;
    g.revoked = true;
    this.dropCredentialsFor(grantId);
    this.audit?.record(by, 'grant.revoke', g.capability, { grantId });
    this.bus?.emit({ type: 'grant.revoked', runId: g.taskId, data: { grantId, capability: g.capability } });
    return true;
  }

  /** Revoke every grant for a task (e.g. when the task ends). Returns the count revoked. */
  revokeTask(taskId: string, _by = 'system'): number {
    let n = 0;
    for (const g of this.grants.values()) {
      if (g.taskId === taskId && !g.revoked) {
        g.revoked = true;
        this.dropCredentialsFor(g.id);
        n++;
      }
    }
    if (n) this.bus?.emit({ type: 'grant.revoked', runId: taskId, data: { taskId, count: n } });
    return n;
  }

  /** All grants, optionally filtered by task. Expired/revoked ones are included with status. */
  list(taskId?: string): Array<Grant & { active: boolean }> {
    return [...this.grants.values()]
      .filter((g) => !taskId || g.taskId === taskId)
      .map((g) => ({ ...g, active: this.valid(g) }));
  }

  /**
   * Mint an ephemeral credential bound to a grant. The secret lives ONLY in memory for the
   * grant's remaining lifetime; callers pass the returned opaque `handle` around and resolve
   * it to the real secret just-in-time. Nothing is persisted.
   */
  mintCredential(grantId: string, secret: string): EphemeralCredential {
    const g = this.grants.get(grantId);
    if (!g || !this.valid(g)) throw new GrantDeniedError('Cannot mint a credential: the backing grant is missing, expired or revoked.');
    const handle = `cred_${randomBytes(12).toString('hex')}`;
    this.credentials.set(handle, { grantId, secret });
    this.audit?.record(g.grantedBy, 'grant.credential.mint', g.capability, { grantId, handle });
    return { handle, grantId, expiresAt: g.expiresAt };
  }

  /**
   * Resolve a credential handle to its secret, but only while the backing grant is still
   * valid. Returns undefined (and forgets the credential) once the grant is gone.
   */
  resolveCredential(handle: string): string | undefined {
    const c = this.credentials.get(handle);
    if (!c) return undefined;
    const g = this.grants.get(c.grantId);
    if (!g || !this.valid(g)) {
      this.credentials.delete(handle);
      return undefined;
    }
    return c.secret;
  }

  private dropCredentialsFor(grantId: string): void {
    for (const [h, c] of this.credentials) if (c.grantId === grantId) this.credentials.delete(h);
  }

  /** Drop expired/revoked grants (and their credentials) from memory. Returns the count removed. */
  prune(): number {
    let n = 0;
    for (const [id, g] of this.grants) {
      if (g.revoked || this.now() >= g.expiresAt) {
        this.grants.delete(id);
        this.dropCredentialsFor(id);
        n++;
      }
    }
    return n;
  }
}
