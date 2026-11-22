/**
 * Governance helpers for long-term memory: PII detection/redaction and the queryable
 * memory audit ledger. These are intentionally dependency-free (regex + SQLite) so the
 * core memory layer can stay governed without pulling in any new runtime dependency.
 *
 * The {@link MemoryAuditStore} is a SEPARATE, queryable ledger (table `memory_audit`) for
 * memory-specific operations. Governed ops still ALSO emit to the tamper-evident
 * {@link AuditLog} — this store exists so memory audit can be filtered by user/namespace/
 * action and surfaced in the CLI, REST API and admin panel without scanning the global log.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';

/** A single PII match found in some text. */
export interface PiiMatch {
  type: 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip';
  value: string;
}

/** Result of scanning + (optionally) redacting text for PII. */
export interface PiiResult {
  /** Text with every detected PII span replaced by a `[REDACTED_<TYPE>]` placeholder. */
  redacted: string;
  /** Every match found (on the original text). */
  matches: PiiMatch[];
  /** True when at least one PII span was found. */
  hasPii: boolean;
}

/** Ordered so longer/more-specific patterns (credit card, ssn) run before phone numbers. */
const PII_PATTERNS: Array<{ type: PiiMatch['type']; re: RegExp; placeholder: string }> = [
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, placeholder: '[REDACTED_EMAIL]' },
  { type: 'credit_card', re: /\b(?:\d[ -]*?){13,16}\b/g, placeholder: '[REDACTED_CREDIT_CARD]' },
  { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: '[REDACTED_SSN]' },
  { type: 'ip', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, placeholder: '[REDACTED_IP]' },
  { type: 'phone', re: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3,4}[ .-]?\d{3,4}\b/g, placeholder: '[REDACTED_PHONE]' },
];

/** Looks like a plausible credit-card number (13–16 digits once separators are stripped). */
const looksLikeCard = (s: string): boolean => {
  const digits = s.replace(/[^\d]/g, '');
  return digits.length >= 13 && digits.length <= 16;
};

/**
 * Detect PII in `text` and return a redacted copy plus the matches. Detection is best-effort
 * (regex-based) and deliberately conservative: an email is matched before its local part could
 * be mistaken for something else, cards/SSNs before generic phone numbers.
 */
export function scanPii(text: string): PiiResult {
  const matches: PiiMatch[] = [];
  let redacted = text;
  for (const { type, re, placeholder } of PII_PATTERNS) {
    redacted = redacted.replace(re, (m) => {
      if (type === 'credit_card' && !looksLikeCard(m)) return m;
      // A bare 7+ digit run already redacted as a card/ssn/ip should not double-match as phone.
      if (type === 'phone' && /REDACTED_/.test(m)) return m;
      matches.push({ type, value: m });
      return placeholder;
    });
  }
  return { redacted, matches, hasPii: matches.length > 0 };
}

/** A persisted memory-audit row. */
export interface MemoryAuditEntry {
  id: string;
  userId: string;
  actor: string;
  action: string;
  namespace: string;
  decision: 'allow' | 'deny' | 'redact';
  reason: string;
  target?: string;
  redactions: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryAuditQuery {
  userId?: string;
  namespace?: string;
  action?: string;
  decision?: string;
  limit?: number;
  offset?: number;
}

interface MemoryAuditRow {
  id: string;
  user_id: string;
  actor: string;
  action: string;
  namespace: string;
  decision: string;
  reason: string;
  target: string | null;
  redactions: number;
  details: string;
  created_at: string;
}

const toEntry = (r: MemoryAuditRow): MemoryAuditEntry => ({
  id: r.id,
  userId: r.user_id,
  actor: r.actor,
  action: r.action,
  namespace: r.namespace,
  decision: r.decision as MemoryAuditEntry['decision'],
  reason: r.reason,
  target: r.target ?? undefined,
  redactions: r.redactions,
  details: fromJson<Record<string, unknown>>(r.details, {}),
  createdAt: r.created_at,
});

/** Queryable ledger for governed memory operations (table `memory_audit`). */
export class MemoryAuditStore {
  constructor(private db: Db) {}

  record(e: Omit<MemoryAuditEntry, 'id' | 'createdAt'>): MemoryAuditEntry {
    const id = newId('maud');
    const now = nowIso();
    this.db.run(
      'INSERT INTO memory_audit (id, user_id, actor, action, namespace, decision, reason, target, redactions, details, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, e.userId, e.actor, e.action, e.namespace, e.decision, e.reason, e.target ?? null, e.redactions, toJson(e.details ?? {}), now,
    );
    return { id, createdAt: now, ...e };
  }

  query(opts: MemoryAuditQuery = {}): { entries: MemoryAuditEntry[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userId) { where.push('user_id = ?'); params.push(opts.userId); }
    if (opts.namespace) { where.push('namespace = ?'); params.push(opts.namespace); }
    if (opts.action) { where.push('(action = ? OR action LIKE ?)'); params.push(opts.action, `${opts.action}.%`); }
    if (opts.decision) { where.push('decision = ?'); params.push(opts.decision); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_audit${clause}`, ...params)?.n ?? 0;
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.db.all<MemoryAuditRow>(`SELECT * FROM memory_audit${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    return { entries: rows.map(toEntry), total };
  }
}
