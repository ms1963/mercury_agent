/**
 * Semantic memory: facts/lessons with FTS5 keyword search + vector similarity,
 * combined with reciprocal-rank fusion. Scoped per user (and optional scope).
 */
import type { Db } from '../db/db.js';
import { fromJson, ftsQuery, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import { VectorIndex } from './embeddings.js';
import type { EmbeddingProvider, MemoryItem } from './providers.js';

export interface Fact extends MemoryItem {
  userId: string;
  scope: string;
  kind: string;
  importance: number;
}

interface FactRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  content: string;
  tags: string | null;
  importance: number;
  embedding: string | null;
  source: string | null;
  created_at: string;
}

const toFact = (r: FactRow, score?: number): Fact => ({
  id: r.id,
  userId: r.user_id,
  scope: r.scope,
  kind: r.kind,
  content: r.content,
  tags: fromJson<string[]>(r.tags, []),
  importance: r.importance,
  source: r.source ?? undefined,
  createdAt: r.created_at,
  score,
});

export class FactStore {
  private index = new VectorIndex<{ userId: string; scope: string }>();
  private loaded = false;

  constructor(private db: Db, private embedder: EmbeddingProvider) {}

  private ensureIndex(): void {
    if (this.loaded) return;
    for (const r of this.db.all<FactRow>('SELECT id, user_id, scope, embedding FROM facts WHERE embedding IS NOT NULL')) {
      const v = fromJson<number[]>(r.embedding, []);
      if (v.length) this.index.upsert(r.id, v, { userId: r.user_id, scope: r.scope });
    }
    this.loaded = true;
  }

  async add(userId: string, content: string, opts: { scope?: string; kind?: string; tags?: string[]; importance?: number; source?: string } = {}): Promise<Fact> {
    this.ensureIndex();
    // De-duplicate near-identical facts.
    const [vector] = await this.embedder.embed([content]).catch(() => [undefined]);
    if (vector) {
      const dup = this.index.search(vector, 1, (m) => m.userId === userId && m.scope === (opts.scope ?? 'global'), 0.97)[0];
      if (dup) return this.get(dup.id)!;
    }
    const id = newId('fact');
    const now = nowIso();
    this.db.run(
      'INSERT INTO facts (id, user_id, scope, kind, content, tags, importance, embedding, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, userId, opts.scope ?? 'global', opts.kind ?? 'fact', content, toJson(opts.tags ?? []), opts.importance ?? 0.5, vector ? toJson(vector) : null, opts.source, now, now,
    );
    this.db.run('INSERT INTO facts_fts (content, fact_id, user_id) VALUES (?,?,?)', content, id, userId);
    if (vector) this.index.upsert(id, vector, { userId, scope: opts.scope ?? 'global' });
    return this.get(id)!;
  }

  get(id: string): Fact | undefined {
    const r = this.db.get<FactRow>('SELECT * FROM facts WHERE id = ?', id);
    return r ? toFact(r) : undefined;
  }

  async update(id: string, content: string): Promise<Fact | undefined> {
    const [vector] = await this.embedder.embed([content]).catch(() => [undefined]);
    this.db.run('UPDATE facts SET content=?, embedding=?, updated_at=? WHERE id=?', content, vector ? toJson(vector) : null, nowIso(), id);
    this.db.run('DELETE FROM facts_fts WHERE fact_id = ?', id);
    const f = this.get(id);
    if (f) {
      this.db.run('INSERT INTO facts_fts (content, fact_id, user_id) VALUES (?,?,?)', content, id, f.userId);
      if (vector) this.index.upsert(id, vector, { userId: f.userId, scope: f.scope });
    }
    return f;
  }

  delete(userId: string, id: string): boolean {
    const r = this.db.run('DELETE FROM facts WHERE id = ? AND user_id = ?', id, userId);
    this.db.run('DELETE FROM facts_fts WHERE fact_id = ?', id);
    this.index.remove(id);
    return r.changes > 0;
  }

  list(userId: string, opts: { scope?: string; kind?: string; limit?: number; offset?: number } = {}): Fact[] {
    const where = ['user_id = ?'];
    const params: (string | number)[] = [userId];
    if (opts.scope) (where.push('scope = ?'), params.push(opts.scope));
    if (opts.kind) (where.push('kind = ?'), params.push(opts.kind));
    return this.db
      .all<FactRow>(`SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ...params, opts.limit ?? 100, opts.offset ?? 0)
      .map((r) => toFact(r));
  }

  /** Hybrid search: FTS5 BM25 + cosine similarity fused with reciprocal rank fusion. */
  async search(userId: string, query: string, k = 5, scope?: string): Promise<Fact[]> {
    this.ensureIndex();
    const ranked = new Map<string, number>();
    const fts = ftsQuery(query);
    if (fts) {
      const rows = this.db.all<{ fact_id: string }>('SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ? AND user_id = ? ORDER BY rank LIMIT ?', fts, userId, k * 3);
      rows.forEach((r, i) => ranked.set(r.fact_id, (ranked.get(r.fact_id) ?? 0) + 1 / (60 + i)));
    }
    const [vector] = await this.embedder.embed([query]).catch(() => [undefined]);
    if (vector) {
      this.index
        .search(vector, k * 3, (m) => m.userId === userId && (!scope || m.scope === scope), 0.15)
        .forEach((hit, i) => ranked.set(hit.id, (ranked.get(hit.id) ?? 0) + 1 / (60 + i)));
    }
    return [...ranked.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const f = this.get(id);
        return f && (!scope || f.scope === scope) ? { ...f, score } : undefined;
      })
      .filter((f) => !!f)
      .map((f) => f as Fact)
      .slice(0, k);
  }
}
