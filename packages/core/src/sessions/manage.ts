/**
 * Session management logic for Mercury (Tier-1 gap #3).
 *
 * Sessions (and their messages) already persist in the SQLite memory DB via
 * {@link ../memory/episodic.js | EpisodicStore}. This module adds a *management* surface over that
 * EXISTING data — it never changes the write path or the schema. The `mercury sessions` CLI
 * (list / rename / export / delete / prune) is built on top of these helpers.
 *
 * The module is split into PURE functions (no fs, no DB — fully unit-testable with injected data and an
 * injected clock) and leaves all storage/IO to the caller, exactly as `backup/` and `reliability/` do:
 *   - {@link sortByRecent}, {@link filterSessions}  — list ordering + title/limit filtering
 *   - {@link findSession}                           — resolve a session by exact id or unique prefix
 *   - {@link parseCutoff}, {@link selectPrune}       — prune-selection given a list, options and a clock
 *   - {@link buildSessionExport}, {@link renderSessionMarkdown} — export shaping (JSON / markdown)
 */
import type { Session, StoredMessage } from '../memory/episodic.js';

/** The recency timestamp a session is ordered/pruned by (updatedAt, falling back to createdAt). */
export function recencyOf(s: Session): string {
  return s.updatedAt || s.createdAt || '';
}

/** A working directory, if one was stored in the session's free-form `meta` (opportunistic, honest). */
export function workingDirOf(s: Session): string | undefined {
  const meta = s.meta as Record<string, unknown> | undefined;
  for (const key of ['cwd', 'workingDir', 'dir']) {
    const v = meta?.[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Sort sessions most-recent-first (by {@link recencyOf}), with createdAt then id as stable tie-breakers
 * so the ordering is fully deterministic for identical timestamps. Returns a new array.
 */
export function sortByRecent(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    if (recencyOf(a) !== recencyOf(b)) return recencyOf(a) < recencyOf(b) ? 1 : -1;
    if ((a.createdAt || '') !== (b.createdAt || '')) return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Options for {@link filterSessions}. */
export interface ListFilter {
  /** Case-insensitive substring match over the session title. */
  search?: string;
  /** Keep only the first N (after sorting + searching). */
  limit?: number;
}

/** Sort most-recent-first, then apply the optional title search and limit. Returns a new array. */
export function filterSessions(list: Session[], filter: ListFilter = {}): Session[] {
  let r = sortByRecent(list);
  if (filter.search && filter.search.trim()) {
    const q = filter.search.trim().toLowerCase();
    r = r.filter((s) => (s.title ?? '').toLowerCase().includes(q));
  }
  if (typeof filter.limit === 'number' && filter.limit >= 0) r = r.slice(0, filter.limit);
  return r;
}

/**
 * Resolve a session by exact id or by a unique id prefix (so users can copy the short id shown in the
 * table). Returns the session, `undefined` when nothing matches, or `'ambiguous'` when a prefix matches
 * more than one session.
 */
export function findSession(list: Session[], idOrPrefix: string): Session | undefined | 'ambiguous' {
  const exact = list.find((s) => s.id === idOrPrefix);
  if (exact) return exact;
  const matches = list.filter((s) => s.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return 'ambiguous';
  return undefined;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a prune cutoff — either a relative **duration** (`30d`, `12h`, `90m`, `2w`, `45s`) interpreted
 * as "older than now minus this", or an absolute **ISO date/datetime** (`2026-01-01`,
 * `2026-01-01T12:00:00Z`). Returns the cutoff instant. Throws on anything it cannot parse.
 */
export function parseCutoff(spec: string, now: Date): Date {
  const trimmed = spec.trim();
  const m = /^(\d+)\s*([smhdw])$/i.exec(trimmed);
  if (m) {
    const n = Number(m[1]);
    const unit = DURATION_UNITS[m[2]!.toLowerCase()]!;
    return new Date(now.getTime() - n * unit);
  }
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return new Date(t);
  throw new Error(
    `invalid --older-than "${spec}" (use a duration like 30d/12h/90m/2w or an ISO date like 2026-01-01)`,
  );
}

/** Options controlling {@link selectPrune}. All are optional; with none given nothing is selected. */
export interface PruneOptions {
  /** Delete sessions whose recency is before this cutoff (duration or ISO date). */
  olderThan?: string;
  /** Protect the N most-recent sessions; with no other criterion, delete everything beyond them. */
  keep?: number;
  /** Delete sessions that have zero messages. */
  empty?: boolean;
}

/** One session chosen for deletion, with the human-readable reason(s) it matched. */
export interface PruneDecision {
  session: Session;
  reasons: string[];
}

/** The outcome of a (pure) prune selection: what would be deleted and what would be kept. */
export interface PruneSelection {
  toDelete: PruneDecision[];
  kept: Session[];
}

/**
 * Pure prune selection — decides which sessions WOULD be deleted, writing nothing. The CLI uses this for
 * both the default dry-run and the actual delete (then it calls the store for each `toDelete`).
 *
 * Semantics (documented in `docs/help/sessions.md`):
 *   - `keep=N` always **protects** the N most-recent sessions from deletion.
 *   - A non-protected session is selected if it matches `olderThan` (recency before the cutoff) OR
 *     `empty` (zero messages) — the union of the active match criteria.
 *   - If `keep` is given but NO match criteria are, every session beyond the top N is selected.
 *   - With no options at all, nothing is selected (safe no-op).
 */
export function selectPrune(list: Session[], opts: PruneOptions, now: Date): PruneSelection {
  const sorted = sortByRecent(list);
  const keepN = typeof opts.keep === 'number' && opts.keep >= 0 ? opts.keep : undefined;
  const protectedIds = new Set<string>(keepN !== undefined ? sorted.slice(0, keepN).map((s) => s.id) : []);
  const cutoff = opts.olderThan ? parseCutoff(opts.olderThan, now) : undefined;
  const hasMatchCriteria = cutoff !== undefined || opts.empty === true;

  const toDelete: PruneDecision[] = [];
  const kept: Session[] = [];
  sorted.forEach((s, idx) => {
    if (protectedIds.has(s.id)) {
      kept.push(s);
      return;
    }
    const reasons: string[] = [];
    if (cutoff && new Date(recencyOf(s)).getTime() < cutoff.getTime()) {
      reasons.push(`older than ${cutoff.toISOString()}`);
    }
    if (opts.empty && (s.messageCount ?? 0) === 0) {
      reasons.push('empty (0 messages)');
    }
    if (keepN !== undefined && !hasMatchCriteria && idx >= keepN) {
      reasons.push(`beyond keep=${keepN}`);
    }
    if (reasons.length) toDelete.push({ session: s, reasons });
    else kept.push(s);
  });
  return { toDelete, kept };
}

/** Wire-format version of a `mercury sessions export` JSON document. */
export const SESSION_EXPORT_VERSION = 1;

/** A self-contained, JSON-serializable export of one session and its messages. */
export interface SessionExport {
  formatVersion: number;
  session: Session;
  messageCount: number;
  messages: StoredMessage[];
}

/** Shape a session + its messages into the JSON export document. */
export function buildSessionExport(session: Session, messages: StoredMessage[]): SessionExport {
  return {
    formatVersion: SESSION_EXPORT_VERSION,
    session,
    messageCount: messages.length,
    messages,
  };
}

/** Render a session + its messages as a human-readable markdown transcript (deterministic). */
export function renderSessionMarkdown(session: Session, messages: StoredMessage[]): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || 'Untitled session'}`, '');
  lines.push(`- **Session:** ${session.id}`);
  lines.push(`- **Created:** ${session.createdAt}`);
  lines.push(`- **Updated:** ${session.updatedAt}`);
  if (session.model) lines.push(`- **Model:** ${session.model}`);
  if (session.platform) lines.push(`- **Platform:** ${session.platform}`);
  if (session.personality) lines.push(`- **Personality:** ${session.personality}`);
  const cwd = workingDirOf(session);
  if (cwd) lines.push(`- **Working dir:** ${cwd}`);
  lines.push(`- **Messages:** ${messages.length}`, '', '---', '');
  for (const msg of messages) {
    const name = msg.name ? ` (${msg.name})` : '';
    lines.push(`### ${msg.role}${name}`, '', msg.content || '_(no content)_', '');
  }
  return lines.join('\n');
}
