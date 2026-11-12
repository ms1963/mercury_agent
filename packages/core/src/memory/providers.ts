/**
 * Extension interfaces for memory:
 *  - MemoryProvider: external memory backends (Honcho, Mem0, Zep, a vector DB...).
 *    Results are merged into recall alongside Mercury's own semantic memory.
 *  - ContextEngine: contributes extra context to the system prompt for a turn.
 */

export interface MemoryItem {
  id: string;
  content: string;
  score?: number;
  kind?: string;
  source?: string;
  tags?: string[];
  createdAt?: string;
}

export interface MemoryProvider {
  name: string;
  remember(userId: string, content: string, meta?: Record<string, unknown>): Promise<void>;
  recall(userId: string, query: string, k: number): Promise<MemoryItem[]>;
  forget?(userId: string, id: string): Promise<void>;
}

export interface ContextEngine {
  name: string;
  /** Return markdown to inject into the system prompt (or empty string). */
  contribute(input: { userId: string; sessionId: string; query: string }): Promise<string>;
}

/** Embedding function: text → vector. */
export interface EmbeddingProvider {
  name: string;
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}
