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
 *   knowledge   → ingested sources, RAG with provenance       (KnowledgeStore)
 *   external    → pluggable MemoryProviders + ContextEngines
 *
 * Everything is scoped per user id, with an additional namespace dimension (v1.4.0) on top of
 * scope. Writes/reads/forgets can be governed: policy-gated, PII-aware, retention-bounded and
 * recorded to a queryable audit ledger. Governance is OFF by default (backward-compatible).
 */
import type { PolicyEngine } from '../auth/policy.js';
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import type { HookManager } from '../plugins/hooks.js';
import type { AuditLog } from '../security/audit.js';
import { MercuryError, errorMessage, type Principal } from '../types/common.js';
import { Blackboard } from './blackboard.js';
import { CuratedMemory, type CuratedFile } from './curated.js';
import { EpisodicStore, type SessionHit } from './episodic.js';
import { FactStore, type Fact } from './facts.js';
import { MemoryAuditStore, scanPii, type MemoryAuditEntry, type MemoryAuditQuery } from './governance.js';
import { KnowledgeStore, type KnowledgeChunk, type KnowledgeDoc } from './knowledge.js';
import type { ContextEngine, EmbeddingProvider, MemoryItem, MemoryProvider } from './providers.js';
import { UserModel } from './user-model.js';

/** Summariser used for session search (wired to the LLM by the runtime). */
export type Summarizer = (userId: string, query: string, text: string) => Promise<string>;

export interface RememberOptions {
  kind?: 'fact' | 'lesson' | 'preference' | 'note';
  scope?: string;
  /** Namespace dimension on top of scope (v1.4.0). Defaults to the configured default namespace. */
  namespace?: string;
  tags?: string[];
  importance?: number;
  source?: string;
  /** Also add to the curated MEMORY.md / USER.md file. */
  curated?: CuratedFile;
  /** Acting principal, used for policy enforcement + audit attribution when governance is on. */
  principal?: Principal;
}

/** Options for a governed recall / forget. */
export interface RecallOptions {
  namespace?: string;
  principal?: Principal;
}

export class MemoryManager {
  readonly facts: FactStore;
  readonly curated: CuratedMemory;
  readonly episodic: EpisodicStore;
  readonly userModel: UserModel;
  readonly blackboard: Blackboard;
  readonly knowledge: KnowledgeStore;
  readonly memoryAudit: MemoryAuditStore;
  private providers: MemoryProvider[] = [];
  private engines: ContextEngine[] = [];
  summarizer?: Summarizer;

  constructor(
    private config: MercuryConfig,
    db: Db,
    readonly embedder: EmbeddingProvider,
    private bus?: EventBus,
    private hooks?: HookManager,
    private policy?: PolicyEngine,
    private audit?: AuditLog,
  ) {
    this.facts = new FactStore(db, embedder);
    this.curated = new CuratedMemory(config.dataDir, { memory: config.memory.memoryCharLimit, user: config.memory.userCharLimit });
    this.episodic = new EpisodicStore(db);
    this.userModel = new UserModel(db);
    this.blackboard = new Blackboard(db);
    this.knowledge = new KnowledgeStore(db, embedder);
    this.memoryAudit = new MemoryAuditStore(db);
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

  private get governed(): boolean {
    return this.config.memory.governance.mode !== 'off';
  }
  private get strict(): boolean {
    return this.config.memory.governance.mode === 'strict';
  }
  private resolveNamespace(ns?: string): string {
    return ns ?? this.config.memory.namespaces.default;
  }

  /** Record a governed op to the queryable memory ledger AND the tamper-evident global audit log. */
  private recordAudit(e: Omit<MemoryAuditEntry, 'id' | 'createdAt'>): void {
    try {
      this.memoryAudit.record(e);
      this.audit?.record(e.actor, `memory.${e.action}`, e.target ?? '', { namespace: e.namespace, decision: e.decision, reason: e.reason, redactions: e.redactions });
    } catch {
      /* auditing must never break a memory op */
    }
  }

  async remember(userId: string, content: string, opts: RememberOptions = {}): Promise<Fact> {
    const g = this.config.memory.governance;
    const namespace = this.resolveNamespace(opts.namespace);
    const actor = opts.principal?.username ?? 'system';

    // Policy enforcement (strict + enforcePolicy only).
    if (this.strict && g.enforcePolicy && this.policy && opts.principal) {
      const reason = this.policy.check(opts.principal, 'memory.write');
      if (reason) {
        this.recordAudit({ userId, actor, action: 'write', namespace, decision: 'deny', reason, redactions: 0, details: {} });
        throw new MercuryError(`Memory write denied: ${reason}`, 'permission_denied', 'security', 403);
      }
    }
    // Namespace allow-list (strict).
    if (this.strict && this.config.memory.namespaces.allowed.length && !this.config.memory.namespaces.allowed.includes(namespace)) {
      this.recordAudit({ userId, actor, action: 'write', namespace, decision: 'deny', reason: 'namespace not allowed', redactions: 0, details: {} });
      throw new MercuryError(`Memory write denied: namespace "${namespace}" is not in the allowed list`, 'permission_denied', 'security', 403);
    }

    const hook = await this.hooks?.run('memory_write', { userId, content, opts });
    if (hook?.block) throw new Error(`Memory write blocked: ${String(hook.block)}`);

    // PII handling.
    let stored = content;
    let redactions = 0;
    let decision: MemoryAuditEntry['decision'] = 'allow';
    if (this.governed && g.pii.detect) {
      const scan = scanPii(content);
      if (scan.hasPii) {
        if (this.strict && g.pii.block) {
          this.recordAudit({ userId, actor, action: 'write', namespace, decision: 'deny', reason: 'contains PII', redactions: scan.matches.length, details: { types: scan.matches.map((m) => m.type) } });
          throw new MercuryError('Memory write denied: content contains PII', 'pii_blocked', 'security', 403);
        }
        if (g.pii.redact) {
          stored = scan.redacted;
          redactions = scan.matches.length;
          decision = 'redact';
        }
      }
    }

    const fact = await this.facts.add(userId, stored, { kind: opts.kind, scope: opts.scope, namespace, tags: opts.tags, importance: opts.importance, source: opts.source });
    if (opts.curated) this.curated.add(userId, opts.curated, stored);
    for (const p of this.providers) await p.remember(userId, stored, { kind: opts.kind }).catch(() => undefined);

    // Retention pruning (governed only).
    if (this.governed) {
      const { ttlDays, maxItemsPerNamespace } = this.config.memory.retention;
      if (ttlDays > 0 || maxItemsPerNamespace > 0) this.facts.prune(userId, { namespace, ttlDays, maxItems: maxItemsPerNamespace });
    }

    if (this.governed) this.recordAudit({ userId, actor, action: 'write', namespace, decision, reason: decision === 'redact' ? 'PII redacted' : '', target: fact.id, redactions, details: { kind: fact.kind } });
    this.bus?.emit({ type: 'memory.write', userId, data: { id: fact.id, kind: fact.kind, namespace, content: stored.slice(0, 200) } });
    return fact;
  }

  /** Hybrid recall over semantic memory plus every external provider. */
  async recall(userId: string, query: string, k = this.config.memory.recallK, scope?: string, opts: RecallOptions = {}): Promise<MemoryItem[]> {
    const g = this.config.memory.governance;
    const namespace = opts.namespace ? this.resolveNamespace(opts.namespace) : undefined;
    const actor = opts.principal?.username ?? 'system';
    if (this.strict && g.enforcePolicy && this.policy && opts.principal) {
      const reason = this.policy.check(opts.principal, 'memory.read');
      if (reason) {
        this.recordAudit({ userId, actor, action: 'read', namespace: namespace ?? 'default', decision: 'deny', reason, redactions: 0, details: {} });
        throw new MercuryError(`Memory read denied: ${reason}`, 'permission_denied', 'security', 403);
      }
    }
    const own: MemoryItem[] = await this.facts.search(userId, query, k, scope, namespace);
    const external = await Promise.all(
      this.providers.map((p) =>
        p.recall(userId, query, k).then((items) => items.map((i) => ({ ...i, source: i.source ?? p.name }))).catch(() => [] as MemoryItem[]),
      ),
    );
    const merged = [...own, ...external.flat()];
    if (this.governed) this.recordAudit({ userId, actor, action: 'read', namespace: namespace ?? 'default', decision: 'allow', reason: '', redactions: 0, details: { query: query.slice(0, 120), hits: merged.length } });
    this.bus?.emit({ type: 'memory.recall', userId, data: { query: query.slice(0, 200), hits: merged.length } });
    return merged.slice(0, k + external.flat().length);
  }

  async forget(userId: string, idOrText: string, opts: RecallOptions = {}): Promise<number> {
    const namespace = this.resolveNamespace(opts.namespace);
    const actor = opts.principal?.username ?? 'system';
    let removed = 0;
    if (this.facts.delete(userId, idOrText)) {
      removed = 1;
    } else {
      // Fall back to matching by content.
      const matches = this.facts.list(userId, { limit: 1000 }).filter((f) => f.content.toLowerCase().includes(idOrText.toLowerCase()));
      for (const f of matches) this.facts.delete(userId, f.id);
      const curated = this.curated.remove(userId, 'memory', idOrText) + this.curated.remove(userId, 'user', idOrText);
      for (const p of this.providers) if (p.forget) await p.forget(userId, idOrText).catch(() => undefined);
      removed = matches.length + curated;
    }
    if (this.governed) this.recordAudit({ userId, actor, action: 'forget', namespace, decision: 'allow', reason: '', target: idOrText.slice(0, 80), redactions: 0, details: { removed } });
    return removed;
  }

  /** Namespaces this user has memory in, with counts. */
  namespaces(userId: string): Array<{ namespace: string; count: number }> {
    return this.facts.namespaces(userId);
  }

  /** Query the governed-memory audit ledger (newest first). */
  auditLog(opts: MemoryAuditQuery = {}): { entries: MemoryAuditEntry[]; total: number } {
    return this.memoryAudit.query(opts);
  }

  /** Ingest a document into the knowledge store (chunked, embedded, with provenance). */
  async addKnowledge(userId: string, doc: KnowledgeDoc, opts: { namespace?: string; principal?: Principal } = {}): Promise<{ sourceId: string; chunks: number }> {
    const namespace = this.resolveNamespace(opts.namespace);
    const res = await this.knowledge.ingest(userId, doc, {
      namespace,
      chunkChars: this.config.memory.knowledge.chunkChars,
      chunkOverlap: this.config.memory.knowledge.chunkOverlap,
    });
    if (this.governed) this.recordAudit({ userId, actor: opts.principal?.username ?? 'system', action: 'knowledge.ingest', namespace, decision: 'allow', reason: '', target: res.sourceId, redactions: 0, details: { chunks: res.chunks, title: doc.title ?? '' } });
    this.bus?.emit({ type: 'memory.write', userId, data: { kind: 'knowledge', namespace, source: res.sourceId, chunks: res.chunks } });
    return res;
  }

  /** Search the knowledge store, returning passages with provenance. */
  async searchKnowledge(userId: string, query: string, k = this.config.memory.knowledge.recallK, opts: { namespace?: string } = {}): Promise<KnowledgeChunk[]> {
    const namespace = opts.namespace ? this.resolveNamespace(opts.namespace) : undefined;
    return this.knowledge.search(userId, query, k, namespace);
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

  /** Memory section of the system prompt: curated files, user model, relevant facts, knowledge, context engines. */
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
      if (this.config.memory.knowledge.enabled) {
        const grounded = await this.searchKnowledge(userId, query).catch(() => []);
        if (grounded.length) {
          parts.push(
            `## Grounding knowledge (cite sources)\n${grounded
              .map((g) => `- ${g.content}\n  (source: ${g.title || g.sourceId}${g.uri ? ` <${g.uri}>` : ''} · ${g.chunkRef})`)
              .join('\n')}`,
          );
        }
      }
    }
    for (const e of this.engines) {
      const extra = await e.contribute({ userId, sessionId, query }).catch(() => '');
      if (extra.trim()) parts.push(extra.trim());
    }
    return parts.join('\n\n');
  }
}
