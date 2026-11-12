/**
 * Embedding providers and a hand-written cosine-similarity vector index.
 *
 *  - HashEmbedding: offline feature hashing of word uni/bi-grams (default, no network).
 *  - OpenAIEmbedding: any OpenAI-compatible /embeddings endpoint (OpenAI, Ollama, LM Studio).
 */
import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './providers.js';

export class HashEmbedding implements EmbeddingProvider {
  readonly name = 'hash';
  constructor(readonly dims = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
    const grams = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
    for (const g of grams) {
      const h = createHash('md5').update(g).digest();
      const idx = h.readUInt32LE(0) % this.dims;
      const sign = h[4]! & 1 ? 1 : -1;
      v[idx]! += sign * (g.includes('_') ? 0.5 : 1);
    }
    return normalize(v);
  }
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name = 'openai';
  constructor(
    private baseUrl: string,
    private model: string,
    readonly dims: number,
    private apiKey?: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => normalize(d.embedding));
  }
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** In-memory vector index (brute force, fine for tens of thousands of items). */
export class VectorIndex<M = unknown> {
  private items = new Map<string, { vector: number[]; meta: M }>();

  upsert(id: string, vector: number[], meta: M): void {
    this.items.set(id, { vector, meta });
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  get size(): number {
    return this.items.size;
  }

  search(query: number[], k = 5, filter: (meta: M) => boolean = () => true, minScore = 0): Array<{ id: string; score: number; meta: M }> {
    const out: Array<{ id: string; score: number; meta: M }> = [];
    for (const [id, item] of this.items) {
      if (!filter(item.meta)) continue;
      const score = cosine(query, item.vector);
      if (score >= minScore) out.push({ id, score, meta: item.meta });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
