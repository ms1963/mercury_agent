/**
 * Knowledge / RAG store: ingest documents from connected sources, chunk + embed them, and recall
 * passages WITH PROVENANCE (source id/title/uri + chunk reference per hit). Hybrid retrieval —
 * FTS5 BM25 keyword search fused with cosine vector similarity via reciprocal-rank fusion — exactly
 * like {@link FactStore}, but scoped per user + namespace and carrying source attribution so the
 * agent can ground answers and cite where each passage came from.
 */
import type { Db } from '../db/db.js';
import { fromJson, ftsQuery, toJson } from '../db/db.js';
import { newId, nowIso } from '../types/common.js';
import { VectorIndex } from './embeddings.js';
import type { EmbeddingProvider } from './providers.js';

/** Provenance attached to every knowledge hit so answers can cite their source. */
export interface Provenance {
  sourceId: string;
  title: string;
  uri: string;
  chunkRef: string;
  chunkIndex: number;
}

/** A single ingested + embedded chunk. */
export interface KnowledgeChunk extends Provenance {
  id: string;
  userId: string;
  namespace: string;
  content: string;
  tags: string[];
  score?: number;
  createdAt?: string;
}

/** Input to ingest one logical document (it is chunked internally). */
export interface KnowledgeDoc {
  /** Stable source identifier (re-ingesting the same id replaces its chunks). */
  sourceId?: string;
  title?: string;
  uri?: string;
  content: string;
  tags?: string[];
}

interface KnowledgeRow {
  id: string;
  user_id: string;
  namespace: string;
  source_id: string;
  title: string;
  uri: string;
  chunk_ref: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  tags: string | null;
  created_at: string;
}

const toChunk = (r: KnowledgeRow, score?: number): KnowledgeChunk => ({
  id: r.id,
  userId: r.user_id,
  namespace: r.namespace,
  sourceId: r.source_id,
  title: r.title,
  uri: r.uri,
  chunkRef: r.chunk_ref,
  chunkIndex: r.chunk_index,
  content: r.content,
  tags: fromJson<string[]>(r.tags, []),
  createdAt: r.created_at,
  score,
});

/** Split text into overlapping chunks on paragraph/sentence boundaries where possible. */
export function chunkText(text: string, chunkChars = 900, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];
  const chunks: string[] = [];
  let start = 0;
  const step = Math.max(1, chunkChars - overlap);
  while (start < clean.length) {
    let end = Math.min(start + chunkChars, clean.length);
    if (end < clean.length) {
      // Prefer to break on a paragraph, then sentence, then whitespace boundary.
      const slice = clean.slice(start, end);
      const brk = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (brk > chunkChars * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start += step;
  }
  return chunks;
}

export class KnowledgeStore {
  private index = new VectorIndex<{ userId: string; namespace: string }>();
  private loaded = false;

  constructor(private db: Db, private embedder: EmbeddingProvider) {}

  private ensureIndex(): void {
    if (this.loaded) return;
    for (const r of this.db.all<KnowledgeRow>('SELECT id, user_id, namespace, embedding FROM knowledge WHERE embedding IS NOT NULL')) {
      const v = fromJson<number[]>(r.embedding, []);
      if (v.length) this.index.upsert(r.id, v, { userId: r.user_id, namespace: r.namespace });
    }
    this.loaded = true;
  }

  /** Ingest one document: chunk → embed each chunk → persist with provenance. Returns chunk count. */
  async ingest(
    userId: string,
    doc: KnowledgeDoc,
    opts: { namespace?: string; chunkChars?: number; chunkOverlap?: number } = {},
  ): Promise<{ sourceId: string; chunks: number }> {
    this.ensureIndex();
    const namespace = opts.namespace ?? 'default';
    const sourceId = doc.sourceId ?? newId('src');
    const title = doc.title ?? '';
    const uri = doc.uri ?? '';
    const tags = doc.tags ?? [];
    // Re-ingesting the same source replaces its existing chunks (idempotent update).
    this.removeSource(userId, sourceId, namespace);
    const pieces = chunkText(doc.content, opts.chunkChars, opts.chunkOverlap);
    if (!pieces.length) return { sourceId, chunks: 0 };
    const vectors = await this.embedder.embed(pieces).catch(() => pieces.map(() => undefined as unknown as number[]));
    const now = nowIso();
    for (let i = 0; i < pieces.length; i++) {
      const id = newId('kch');
      const vector = vectors[i];
      const chunkRef = `${sourceId}#${i}`;
      this.db.run(
        'INSERT INTO knowledge (id, user_id, namespace, source_id, title, uri, chunk_ref, chunk_index, content, embedding, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, userId, namespace, sourceId, title, uri, chunkRef, i, pieces[i]!, vector && vector.length ? toJson(vector) : null, toJson(tags), now, now,
      );
      this.db.run('INSERT INTO knowledge_fts (content, chunk_id, user_id, namespace) VALUES (?,?,?,?)', pieces[i]!, id, userId, namespace);
      if (vector && vector.length) this.index.upsert(id, vector, { userId, namespace });
    }
    return { sourceId, chunks: pieces.length };
  }

  /** Remove every chunk of one source. Returns the number of chunks removed. */
  removeSource(userId: string, sourceId: string, namespace?: string): number {
    const rows = this.db.all<{ id: string }>(
      `SELECT id FROM knowledge WHERE user_id = ? AND source_id = ?${namespace ? ' AND namespace = ?' : ''}`,
      ...(namespace ? [userId, sourceId, namespace] : [userId, sourceId]),
    );
    for (const r of rows) {
      this.db.run('DELETE FROM knowledge_fts WHERE chunk_id = ?', r.id);
      this.index.remove(r.id);
    }
    const res = this.db.run(
      `DELETE FROM knowledge WHERE user_id = ? AND source_id = ?${namespace ? ' AND namespace = ?' : ''}`,
      ...(namespace ? [userId, sourceId, namespace] : [userId, sourceId]),
    );
    return res.changes;
  }

  /** Distinct ingested sources for a user (+namespace), with chunk counts. */
  sources(userId: string, namespace?: string): Array<{ sourceId: string; title: string; uri: string; chunks: number }> {
    const where = ['user_id = ?'];
    const params: (string | number)[] = [userId];
    if (namespace) { where.push('namespace = ?'); params.push(namespace); }
    return this.db.all<{ sourceId: string; title: string; uri: string; chunks: number }>(
      `SELECT source_id AS sourceId, MAX(title) AS title, MAX(uri) AS uri, COUNT(*) AS chunks
       FROM knowledge WHERE ${where.join(' AND ')} GROUP BY source_id ORDER BY MAX(created_at) DESC`,
      ...params,
    );
  }

  /** Hybrid search returning passages with provenance, newest-relevance first. */
  async search(userId: string, query: string, k = 4, namespace?: string): Promise<KnowledgeChunk[]> {
    this.ensureIndex();
    const ranked = new Map<string, number>();
    const fts = ftsQuery(query);
    if (fts) {
      const where = namespace ? 'knowledge_fts MATCH ? AND user_id = ? AND namespace = ?' : 'knowledge_fts MATCH ? AND user_id = ?';
      const rows = this.db.all<{ chunk_id: string }>(
        `SELECT chunk_id FROM knowledge_fts WHERE ${where} ORDER BY rank LIMIT ?`,
        ...(namespace ? [fts, userId, namespace, k * 3] : [fts, userId, k * 3]),
      );
      rows.forEach((r, i) => ranked.set(r.chunk_id, (ranked.get(r.chunk_id) ?? 0) + 1 / (60 + i)));
    }
    const [vector] = await this.embedder.embed([query]).catch(() => [undefined]);
    if (vector) {
      this.index
        .search(vector, k * 3, (m) => m.userId === userId && (!namespace || m.namespace === namespace), 0.15)
        .forEach((hit, i) => ranked.set(hit.id, (ranked.get(hit.id) ?? 0) + 1 / (60 + i)));
    }
    return [...ranked.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const r = this.db.get<KnowledgeRow>('SELECT * FROM knowledge WHERE id = ?', id);
        return r && (!namespace || r.namespace === namespace) ? toChunk(r, score) : undefined;
      })
      .filter((c): c is KnowledgeChunk => !!c)
      .slice(0, k);
  }
}
