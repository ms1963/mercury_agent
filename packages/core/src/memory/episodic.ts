/**
 * Episodic memory: sessions and their messages, persisted in SQLite with an FTS5
 * index for cross-session search ("what did we discuss about X last week?").
 */
import type { Db } from '../db/db.js';
import { fromJson, ftsQuery, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import type { ChatMessage } from '../types/messages.js';

export interface Session {
  id: string;
  userId: string;
  title: string;
  platform?: string;
  model?: string;
  pattern?: string;
  personality?: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  seq: number;
  runId?: string;
  createdAt: string;
}

export interface SessionHit {
  sessionId: string;
  title: string;
  messageId: string;
  snippet: string;
  createdAt: string;
}

interface SessionRow {
  id: string; user_id: string; title: string | null; platform: string | null; model: string | null;
  pattern: string | null; personality: string | null; meta: string | null; created_at: string; updated_at: string; n?: number;
}
interface MessageRow {
  id: string; seq: number; role: string; content: string; tool_calls: string | null; tool_call_id: string | null;
  name: string | null; attachments: string | null; untrusted: number; run_id: string | null; created_at: string;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id, userId: r.user_id, title: r.title ?? 'New chat', platform: r.platform ?? undefined, model: r.model ?? undefined,
  pattern: r.pattern ?? undefined, personality: r.personality ?? undefined, meta: fromJson(r.meta, {}),
  createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.n,
});

const toMessage = (r: MessageRow): StoredMessage => ({
  id: r.id, seq: r.seq, role: r.role as ChatMessage['role'], content: r.content,
  toolCalls: fromJson(r.tool_calls, undefined), toolCallId: r.tool_call_id ?? undefined, name: r.name ?? undefined,
  attachments: fromJson(r.attachments, undefined), untrusted: !!r.untrusted, runId: r.run_id ?? undefined, createdAt: r.created_at,
});

export class EpisodicStore {
  constructor(private db: Db) {}

  createSession(userId: string, opts: Partial<Pick<Session, 'title' | 'platform' | 'model' | 'pattern' | 'personality' | 'meta'>> & { id?: string } = {}): Session {
    const id = opts.id ?? newId('ses');
    const now = nowIso();
    this.db.run(
      'INSERT INTO sessions (id, user_id, title, platform, model, pattern, personality, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, userId, opts.title ?? 'New chat', opts.platform, opts.model, opts.pattern, opts.personality, toJson(opts.meta ?? {}), now, now,
    );
    return this.getSession(id)!;
  }

  getSession(id: string): Session | undefined {
    const r = this.db.get<SessionRow>('SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s WHERE id = ?', id);
    return r ? toSession(r) : undefined;
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'model' | 'pattern' | 'personality' | 'meta'>>): Session | undefined {
    const s = this.getSession(id);
    if (!s) return undefined;
    const next = { ...s, ...patch };
    this.db.run('UPDATE sessions SET title=?, model=?, pattern=?, personality=?, meta=?, updated_at=? WHERE id=?', next.title, next.model, next.pattern, next.personality, toJson(next.meta), nowIso(), id);
    return this.getSession(id);
  }

  listSessions(userId: string, limit = 50, offset = 0): Session[] {
    return this.db
      .all<SessionRow>('SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?', userId, limit, offset)
      .map(toSession);
  }

  /**
   * List EVERY session across all users, most-recent-first. Read-only; used by the `mercury sessions`
   * management CLI (which operates instance-wide, not per-user). Does not change the write path.
   */
  listAll(limit = 1000, offset = 0): Session[] {
    return this.db
      .all<SessionRow>('SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s ORDER BY updated_at DESC LIMIT ? OFFSET ?', limit, offset)
      .map(toSession);
  }

  deleteSession(id: string): void {
    this.db.run('DELETE FROM messages_fts WHERE session_id = ?', id);
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  append(sessionId: string, userId: string, msg: ChatMessage, runId?: string): StoredMessage {
    const id = newId('msg');
    const seq = (this.db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM messages WHERE session_id = ?', sessionId)?.s ?? 0) + 1;
    const now = nowIso();
    this.db.run(
      'INSERT INTO messages (id, session_id, user_id, seq, role, content, tool_calls, tool_call_id, name, attachments, untrusted, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, sessionId, userId, seq, msg.role, msg.content, msg.toolCalls ? toJson(msg.toolCalls) : null, msg.toolCallId, msg.name,
      msg.attachments?.length ? toJson(msg.attachments.map(({ data: _d, ...a }) => a)) : null, msg.untrusted ? 1 : 0, runId, now,
    );
    // Only user/assistant prose is worth searching; tool output stays out of the index.
    if ((msg.role === 'user' || msg.role === 'assistant') && msg.content.trim()) {
      this.db.run('INSERT INTO messages_fts (content, message_id, session_id, user_id) VALUES (?,?,?,?)', msg.content, id, sessionId, userId);
    }
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', now, sessionId);
    return { ...msg, id, seq, runId, createdAt: now };
  }

  messages(sessionId: string, limit = 500): StoredMessage[] {
    return this.db.all<MessageRow>('SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC', sessionId, limit).map(toMessage);
  }

  /** Delete every message with seq >= fromSeq (used by /undo and /retry). */
  truncateFrom(sessionId: string, fromSeq: number): number {
    const ids = this.db.all<{ id: string }>('SELECT id FROM messages WHERE session_id = ? AND seq >= ?', sessionId, fromSeq);
    for (const { id } of ids) this.db.run('DELETE FROM messages_fts WHERE message_id = ?', id);
    return this.db.run('DELETE FROM messages WHERE session_id = ? AND seq >= ?', sessionId, fromSeq).changes;
  }

  /** Replace a session's history (used by /compress). */
  replaceMessages(sessionId: string, userId: string, msgs: ChatMessage[]): void {
    this.truncateFrom(sessionId, 0);
    for (const m of msgs) this.append(sessionId, userId, m);
  }

  /** Full-text search across a user's sessions. */
  search(userId: string, query: string, limit = 10): SessionHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db
      .all<{ message_id: string; session_id: string; snip: string; title: string | null; created_at: string }>(
        `SELECT f.message_id, f.session_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip, s.title, m.created_at
         FROM messages_fts f JOIN sessions s ON s.id = f.session_id JOIN messages m ON m.id = f.message_id
         WHERE messages_fts MATCH ? AND f.user_id = ? ORDER BY rank LIMIT ?`,
        q, userId, limit,
      )
      .map((r) => ({ sessionId: r.session_id, title: r.title ?? '', messageId: r.message_id, snippet: r.snip, createdAt: r.created_at }));
  }
}
