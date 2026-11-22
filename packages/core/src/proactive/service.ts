/**
 * Proactive (but not annoying) subsystem.
 *
 * Event sources produce events; declarative rules map event patterns (source/kind/contains) to an
 * optional agent action and a base priority; the {@link scorePriority} model decides interrupt-now
 * vs defer; high-priority events notify immediately while low-priority ones accumulate in a digest
 * queue that is flushed on a schedule (reusing the Scheduler). Disabled by default and fully
 * backward-compatible. No mocks — sources wire to real gateway events / HTTP webhooks and delivery
 * goes through the runtime's real gateway.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../types/common.js';
import { scorePriority } from './priority.js';
import { spotlight } from '../security/injection.js';
import type { EventSource } from './sources.js';

export interface ProactiveEventInput {
  source: string;
  kind: string;
  userId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Base priority if no rule matches (0..1). */
  priority?: number;
}

export type ProactiveDecision = 'interrupt' | 'defer';
export type ProactiveStatus = 'pending' | 'notified' | 'deferred' | 'digested';

export interface ProactiveEvent {
  id: string;
  source: string;
  kind: string;
  userId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  priority: number;
  decision: ProactiveDecision;
  status: ProactiveStatus;
  rule?: string;
  createdAt: string;
  handledAt?: string;
}

export interface DigestResult {
  count: number;
  events: ProactiveEvent[];
  summary: string;
}

/** Callbacks the runtime wires to real delivery / agent execution (never mocked in product code). */
export interface ProactiveDeps {
  /** Deliver a notification (single event or digest) to the configured target. */
  deliver?: (text: string, event?: ProactiveEvent) => Promise<void>;
  /** Run an agent action for a matched interrupt (the rule's `action`, interpolated). */
  runAction?: (task: string, event: ProactiveEvent, meta?: { tainted: boolean; data?: string }) => Promise<void>;
}

type Rule = MercuryConfig['proactive']['rules'][number];

/** Minimal glob matcher supporting '*' segments. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (!pattern.includes('*')) return false;
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);
}

export class ProactiveService {
  private sources: EventSource[] = [];
  private offs: Array<() => void> = [];

  constructor(private config: MercuryConfig, private db?: Db, private bus?: EventBus, private deps: ProactiveDeps = {}) {}

  get enabled(): boolean {
    return this.config.proactive.enabled;
  }

  /** Register an event source (idempotent by name). */
  register(source: EventSource): void {
    if (!this.sources.some((s) => s.name === source.name)) this.sources.push(source);
  }

  /** Start all registered sources (subscribes them to their upstreams). */
  start(): void {
    if (!this.enabled || this.offs.length) return;
    for (const src of this.sources) this.offs.push(src.start((ev) => void this.ingest(ev).catch(() => undefined)));
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  sourceNames(): string[] {
    return this.sources.map((s) => s.name);
  }

  /** Find the first configured rule matching an event (source/kind glob + optional substring). */
  matchRule(input: { source: string; kind: string; title?: string; body?: string }): Rule | undefined {
    const hay = `${input.title ?? ''} ${input.body ?? ''}`.toLowerCase();
    return this.config.proactive.rules.find(
      (r) => globMatch(r.source, input.source) && globMatch(r.kind, input.kind) && (!r.contains || hay.includes(r.contains.toLowerCase())),
    );
  }

  /**
   * Ingest an event: score its priority, decide interrupt vs defer, persist it, and (if interrupt)
   * notify immediately and run any matched action. Deferred events wait for the next digest.
   */
  async ingest(input: ProactiveEventInput): Promise<ProactiveEvent> {
    const rule = this.matchRule(input);
    const base = rule?.priority ?? input.priority ?? 0.5;
    const priority = scorePriority(input, base);
    const decision: ProactiveDecision = rule?.route === 'interrupt' ? 'interrupt' : rule?.route === 'digest' ? 'defer' : priority >= this.config.proactive.interruptThreshold ? 'interrupt' : 'defer';
    const ev: ProactiveEvent = {
      id: newId('pev'),
      source: input.source,
      kind: input.kind,
      userId: input.userId,
      title: input.title,
      body: input.body,
      data: input.data,
      priority,
      decision,
      status: decision === 'interrupt' ? 'notified' : 'deferred',
      rule: rule?.id,
      createdAt: nowIso(),
    };
    this.persist(ev);
    this.bus?.emit({ type: 'proactive.event', userId: ev.userId, data: { id: ev.id, source: ev.source, kind: ev.kind, priority, decision, rule: ev.rule } });

    if (decision === 'interrupt') {
      await this.deps.deliver?.(`[${ev.source}/${ev.kind}] ${ev.title ?? ''}${ev.body ? `\n${ev.body}` : ''}`.trim(), ev).catch(() => undefined);
      if (rule?.action) {
        // Event title/body come from third parties (mail, webhooks): mark the run tainted so sensitive
        // tools need approval instead of running on injected text, and hand the raw values to the
        // runtime spotlighted as data. (Function replacers: no `$&`-style pattern expansion.)
        const tainted = /\{\{(title|body)\}\}/.test(rule.action);
        const task = rule.action.replace(/\{\{title\}\}/g, () => ev.title ?? '').replace(/\{\{body\}\}/g, () => ev.body ?? '');
        const data = tainted ? spotlight([ev.title, ev.body].filter(Boolean).join('\n'), `proactive:${ev.source}`) : undefined;
        await this.deps.runAction?.(task, ev, { tainted, data }).catch(() => undefined);
      }
    }
    return ev;
  }

  private persist(ev: ProactiveEvent): void {
    this.db?.run(
      'INSERT INTO proactive_events (id, source, kind, user_id, title, body, data, priority, decision, status, rule, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ev.id, ev.source, ev.kind, ev.userId ?? null, ev.title ?? null, ev.body ?? null, ev.data ? toJson(ev.data) : null, ev.priority, ev.decision, ev.status, ev.rule ?? null, ev.createdAt,
    );
  }

  /** Recent events (most recent first). */
  events(limit = 50): ProactiveEvent[] {
    if (!this.db) return [];
    return this.db.all('SELECT * FROM proactive_events ORDER BY created_at DESC LIMIT ?', limit).map((r) => this.row(r));
  }

  /** Deferred events still waiting in the digest queue. */
  deferred(limit = 200): ProactiveEvent[] {
    if (!this.db) return [];
    return this.db.all("SELECT * FROM proactive_events WHERE status = 'deferred' ORDER BY created_at DESC LIMIT ?", limit).map((r) => this.row(r));
  }

  /** Bundle all deferred events into a single digest, deliver it, and mark them digested. */
  async flushDigest(): Promise<DigestResult> {
    const pending = this.deferred();
    if (!pending.length) return { count: 0, events: [], summary: 'No updates to digest.' };
    const bySource = new Map<string, ProactiveEvent[]>();
    for (const e of pending) (bySource.get(e.source) ?? bySource.set(e.source, []).get(e.source)!).push(e);
    const lines = [`Digest — ${pending.length} update(s) you deferred:`];
    for (const [src, evs] of bySource) {
      lines.push(`\n${src} (${evs.length}):`);
      for (const e of evs) lines.push(`  • ${e.title ?? e.kind} [p=${e.priority.toFixed(2)}]`);
    }
    const summary = lines.join('\n');
    await this.deps.deliver?.(summary).catch(() => undefined);
    const now = nowIso();
    const ids = pending.map((e) => e.id);
    this.db?.run(`UPDATE proactive_events SET status = 'digested', handled_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now, ...ids);
    this.bus?.emit({ type: 'proactive.digest', data: { count: pending.length, sources: [...bySource.keys()] } });
    return { count: pending.length, events: pending, summary };
  }

  /** Actively poll any source that supports polling; returns how many events were produced. */
  async poll(): Promise<{ polled: number }> {
    let polled = 0;
    for (const src of this.sources) if (src.poll) polled += await src.poll((ev) => void this.ingest(ev).catch(() => undefined));
    return { polled };
  }

  /** Configured rules in a UI-friendly shape. */
  rules(): Array<{ id: string; source: string; kind: string; route: string; priority: number; description: string }> {
    return this.config.proactive.rules.map((r) => ({ id: r.id, source: r.source, kind: r.kind, route: r.route ?? '', priority: r.priority, description: r.description }));
  }

  private row(r: Record<string, unknown>): ProactiveEvent {
    return {
      id: String(r.id),
      source: String(r.source),
      kind: String(r.kind),
      userId: (r.user_id as string) ?? undefined,
      title: (r.title as string) ?? undefined,
      body: (r.body as string) ?? undefined,
      data: r.data ? fromJson<Record<string, unknown>>(r.data, {}) : undefined,
      priority: Number(r.priority),
      decision: (r.decision as ProactiveDecision) ?? 'defer',
      status: (r.status as ProactiveStatus) ?? 'pending',
      rule: (r.rule as string) ?? undefined,
      createdAt: String(r.created_at),
      handledAt: (r.handled_at as string) ?? undefined,
    };
  }
}
