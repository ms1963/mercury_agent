/**
 * DM pairing: an unknown chat user receives a short code; a logged-in Mercury user
 * (or an admin) approves it, linking the platform identity to the Mercury account.
 */
import { randomInt } from 'node:crypto';
import type { Db } from '../db/db.js';
import { MercuryError, nowIso } from '../types/common.js';
import type { UserService } from './users.js';
import type { AuditLog } from '../security/audit.js';

export interface PairingRequest {
  code: string;
  platform: string;
  externalId: string;
  chatId?: string;
  displayName?: string;
  status: 'pending' | 'approved' | 'rejected';
  userId?: string;
  createdAt: string;
  expiresAt: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export class PairingService {
  constructor(private db: Db, private users: UserService, private ttlMinutes = 30, private audit?: AuditLog) {}

  /** Get the pending code for an identity, or create a new one. */
  request(platform: string, externalId: string, chatId?: string, displayName?: string): PairingRequest {
    const existing = this.db.get<Record<string, string>>(
      "SELECT * FROM pairing_codes WHERE platform=? AND external_id=? AND status='pending' AND expires_at > ?",
      platform, externalId, nowIso(),
    );
    if (existing) return this.map(existing);
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expires = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
    this.db.run(
      'INSERT INTO pairing_codes (code, platform, external_id, chat_id, display_name, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      code, platform, externalId, chatId, displayName, nowIso(), expires,
    );
    return this.get(code)!;
  }

  get(code: string): PairingRequest | undefined {
    const r = this.db.get<Record<string, string>>('SELECT * FROM pairing_codes WHERE code = ?', code.toUpperCase());
    return r ? this.map(r) : undefined;
  }

  listPending(): PairingRequest[] {
    return this.db.all<Record<string, string>>("SELECT * FROM pairing_codes WHERE status='pending' AND expires_at > ? ORDER BY created_at DESC", nowIso()).map((r) => this.map(r));
  }

  /** Approve a code for `userId`, linking the chat identity. `actor` is who performed the approval. */
  approve(code: string, userId: string, actor?: string, opts: { relink?: boolean } = {}): PairingRequest {
    const req = this.get(code);
    if (!req || req.status !== 'pending') throw new MercuryError('Unknown or already used pairing code', 'pairing_invalid', 'gateway', 404);
    if (req.expiresAt < nowIso()) throw new MercuryError('Pairing code expired', 'pairing_expired', 'gateway', 410);
    // Never silently move an identity that is already linked to another user (SC-20).
    let linked: { id: string } | undefined;
    try {
      linked = this.users.findIdentity(req.platform, req.externalId);
    } catch {
      linked = undefined; // dangling identity of a deleted user → safe to re-link
    }
    if (linked && linked.id !== userId && !opts.relink) {
      throw new MercuryError(`This ${req.platform} identity is already linked to another user; approve with relink to move it`, 'pairing_linked', 'gateway', 409);
    }
    this.users.linkIdentity(req.platform, req.externalId, userId, req.displayName);
    this.db.run("UPDATE pairing_codes SET status='approved', user_id=? WHERE code=?", userId, req.code);
    this.audit?.record(actor ?? userId, 'pairing.approve', req.code, { platform: req.platform, externalId: req.externalId, linkedUserId: userId });
    return this.get(req.code)!;
  }

  reject(code: string, actor?: string): void {
    const req = this.get(code);
    this.db.run("UPDATE pairing_codes SET status='rejected' WHERE code=?", code.toUpperCase());
    if (req) this.audit?.record(actor ?? 'system', 'pairing.reject', req.code, { platform: req.platform, externalId: req.externalId });
  }

  private map(r: Record<string, string>): PairingRequest {
    return {
      code: r.code!,
      platform: r.platform!,
      externalId: r.external_id!,
      chatId: r.chat_id ?? undefined,
      displayName: r.display_name ?? undefined,
      status: r.status as PairingRequest['status'],
      userId: r.user_id ?? undefined,
      createdAt: r.created_at!,
      expiresAt: r.expires_at!,
    };
  }
}
