/**
 * MemoryManager — one façade over all memory types:
 *
 *   working     → the run's message list (compressed by agent/compression.ts)
 *   episodic    → sessions + messages with FTS5 search      (EpisodicStore)
 *   semantic    → facts/lessons with hybrid vector search    (FactStore)
 *   procedural  → skills                                     (SkillRegistry, separate)
 *   curated     → bounded MEMORY.md / USER.md                (CuratedMemory)
 *   user model  → Honcho-like traits                         (UserModel)
 *   blackboard  → shared multi-agent scratch space           (Blackboard)
 *   external    → pluggable MemoryProviders + ContextEngines
 *
 * Everything is scoped per user id.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import type { HookManager } from '../plugins/hooks.js';
import { errorMessage } from '../types/common.js';
import { Blackboard } from './blackboard.js';
import { CuratedMemory, type CuratedFile } from './curated.js';
import { EpisodicStore, type SessionHit } from './episodic.js';
import { FactStore, type Fact } from './facts.js';
import type { ContextEngine, EmbeddingProvider, MemoryItem, MemoryProvider } from './providers.js';
import { UserModel } from './user-model.js';

/** Summariser used for session search (wired to the LLM by the runtime). */
export type Summarizer = (userId: string, query: string, text: string) => Promise<string>;

export interface RememberOptions {
  kind?: 'fact' | 'lesson' | 'preference' | 'note';
  scope?: string;
  tags?: string[];
  importance?: number;
  source?: string;
  /** Also add to the curated MEMORY.md / USER.md file. */
  curated?: CuratedFile;
}

export class MemoryManager {
  readonly facts: FactStore;
  readonly curated: CuratedMemory;
  readonly episodic: EpisodicStore;
  readonly userModel: UserModel;
  readonly blackboard: Blackboard;
  private providers: MemoryProvider[] = [];
  private engines: ContextEngine[] = [];
  summarizer?: Summarizer;

  constructor(
    private config: MercuryConfig,
    db: Db,
    embedder: EmbeddingProvider,
    private bus?: EventBus,
    private hooks?: HookManager,
  ) {
    this.facts = new FactStore(db, embedder);
    this.curated = new CuratedMemory(config.dataDir, { memory: config.memory.memoryCharLimit, user: config.memory.userCharLimit });
    this.episodic = new EpisodicStore(db);
    this.userModel = new UserModel(db);
    this.blackboard = new Blackboard(db);
  }

  addProvider(p: MemoryProvider): void {
    this.providers.push(p);
  }
  addContextEngine(e: ContextEngine): void {
    this.engines.push(e);
  }
  providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  async remember(userId: string, content: string, opts: RememberOptions = {}): Promise<Fact> {
    const hook = await this.hooks?.run('memory_write', { userId, content, opts });
    if (hook?.block) throw new Error(`Memory write blocked: ${String(hook.block)}`);
    const fact = await this.facts.add(userId, content, { kind: opts.kind, scope: opts.scope, tags: opts.tags, importance: opts.importance, source: opts.source });
    if (opts.curated) this.curated.add(userId, opts.curated, content);
    for (const p of this.providers) await p.remember(userId, content, { kind: opts.kind }).catch(() => undefined);
    this.bus?.emit({ type: 'memory.write', userId, data: { id: fact.id, kind: fact.kind, content: content.slice(0, 200) } });
    return fact;
  }

  /** Hybrid recall over semantic memory plus every external provider. */
  async recall(userId: string, query: string, k = this.config.memory.recallK, scope?: string): Promise<MemoryItem[]> {
    const own: MemoryItem[] = await this.facts.search(userId, query, k, scope);
    const external = await Promise.all(
      this.providers.map((p) =>
        p.recall(userId, query, k).then((items) => items.map((i) => ({ ...i, source: i.source ?? p.name }))).catch(() => [] as MemoryItem[]),
      ),
    );
    const merged = [...own, ...external.flat()];
    this.bus?.emit({ type: 'memory.recall', userId, data: { query: query.slice(0, 200), hits: merged.length } });
    return merged.slice(0, k + external.flat().length);
  }

  async forget(userId: string, idOrText: string): Promise<number> {
    if (this.facts.delete(userId, idOrText)) return 1;
    // Fall back to matching by content.
    const matches = this.facts.list(userId, { limit: 1000 }).filter((f) => f.content.toLowerCase().includes(idOrText.toLowerCase()));
    for (const f of matches) this.facts.delete(userId, f.id);
    const curated = this.curated.remove(userId, 'memory', idOrText) + this.curated.remove(userId, 'user', idOrText);
    for (const p of this.providers) if (p.forget) await p.forget(userId, idOrText).catch(() => undefined);
    return matches.length + curated;
  }

  /** FTS search over past sessions, optionally summarised by the LLM. */
  async searchSessions(userId: string, query: string, opts: { limit?: number; summarize?: boolean } = {}): Promise<{ hits: SessionHit[]; summary?: string }> {
    const hits = this.episodic.search(userId, query, opts.limit ?? 10);
    if (!opts.summarize || !hits.length || !this.summarizer) return { hits };
    try {
      const text = hits.map((h) => `[${h.createdAt.slice(0, 10)} · ${h.title}] ${h.snippet}`).join('\n');
      return { hits, summary: await this.summarizer(userId, query, text) };
    } catch (err) {
      return { hits, summary: `(summary unavailable: ${errorMessage(err)})` };
    }
  }

  /** Memory section of the system prompt: curated files, user model, relevant facts, context engines. */
  async buildContext(userId: string, sessionId: string, query: string): Promise<string> {
    const parts: string[] = [];
    const mem = this.curated.read(userId, 'memory').trim();
    const usr = this.curated.read(userId, 'user').trim();
    if (mem && mem !== '# MEMORY') parts.push(`## Your notes (MEMORY.md)\n${mem.replace(/^# MEMORY\n?/, '')}`);
    if (usr && usr !== '# USER') parts.push(`## About the user (USER.md)\n${usr.replace(/^# USER\n?/, '')}`);
    if (this.config.reflection.userModel) {
      const traits = this.userModel.summary(userId);
      if (traits) parts.push(`## User model (learned traits)\n${traits}`);
    }
    if (query.trim()) {
      const recalled = await this.recall(userId, query).catch(() => []);
      if (recalled.length) parts.push(`## Possibly relevant memories\n${recalled.map((r) => `- (${r.kind ?? 'memory'}) ${r.content}`).join('\n')}`);
    }
    for (const e of this.engines) {
      const extra = await e.contribute({ userId, sessionId, query }).catch(() => '');
      if (extra.trim()) parts.push(extra.trim());
    }
    return parts.join('\n\n');
  }
}
