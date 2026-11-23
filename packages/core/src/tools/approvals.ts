/**
 * Approval service: the human-in-the-loop control point for risky actions.
 *
 * Front-ends either register an interactive handler for their platform (the CLI
 * prompts in the terminal) or resolve pending requests through the API (web UI,
 * chat gateway replies "/approve <id>"). Unanswered requests are denied on timeout.
 */
import type { EventBus } from '../events/bus.js';
import { newId } from '../types/common.js';
import type { ApprovalRequest } from './types.js';

export interface PendingApproval extends ApprovalRequest {
  id: string;
  runId?: string;
  userId: string;
  platform: string;
  createdAt: string;
}

export type ApprovalHandler = (req: PendingApproval) => Promise<boolean>;

/** Tunables for how long unanswered approvals wait and which platforms can be answered via the API. */
export interface ApprovalOptions {
  /** Timeout for a request that can be answered (handler present or API-answerable platform). */
  timeoutMs?: number;
  /** Timeout for the wait path when no interactive handler is registered (unattended='wait'). */
  noHandlerTimeoutMs?: number;
  /** Platforms whose approvals a human/admin realistically resolves through the HTTP API/UI. */
  apiAnswerablePlatforms?: Iterable<string>;
}

export class ApprovalService {
  private pending = new Map<string, { req: PendingApproval; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, ApprovalHandler>();
  private readonly timeoutMs: number;
  private readonly noHandlerTimeoutMs: number;
  /** Platforms declared answerable through the HTTP approvals API even without an in-process handler. */
  private readonly apiAnswerable: Set<string>;

  constructor(private bus: EventBus, opts: ApprovalOptions | number = {}) {
    // Backwards compatible: a number was historically the single timeout argument.
    const o: ApprovalOptions = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    // Default lowered from 5 minutes to 60s so an unanswered request fails fast instead of stalling chat.
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.noHandlerTimeoutMs = o.noHandlerTimeoutMs ?? this.timeoutMs;
    this.apiAnswerable = new Set(o.apiAnswerablePlatforms ?? []);
  }

  /** Register an interactive handler for a platform (e.g. "cli"). */
  setHandler(platform: string, handler: ApprovalHandler | undefined): void {
    if (handler) this.handlers.set(platform, handler);
    else this.handlers.delete(platform);
  }

  /** True if an approval on this platform can realistically be answered (interactive handler or API). */
  isAnswerable(platform: string): boolean {
    return this.handlers.has(platform) || this.apiAnswerable.has(platform);
  }

  /** True if an in-process interactive handler is registered for the platform (e.g. the CLI prompt). */
  hasHandler(platform: string): boolean {
    return this.handlers.has(platform);
  }

  async request(req: ApprovalRequest, meta: { runId?: string; userId: string; platform: string }): Promise<boolean> {
    const full: PendingApproval = { ...req, ...meta, id: newId('apr'), createdAt: new Date().toISOString() };
    this.bus.emit({ type: 'approval.request', runId: meta.runId, userId: meta.userId, data: { ...full } });
    const handler = this.handlers.get(meta.platform);
    // With a handler we await it directly. Without one we register a pending request that an API/UI
    // resolver (POST /api/approvals/:id) can answer, falling back to a timeout-deny — now a short,
    // configurable wait instead of the previous hard-coded 5 minutes.
    const waitMs = handler ? this.timeoutMs : this.noHandlerTimeoutMs;
    const decision = handler
      ? await handler(full).catch(() => false)
      : await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => this.resolve(full.id, false, 'timeout'), waitMs);
          this.pending.set(full.id, { req: full, resolve, timer });
        });
    this.bus.emit({ type: 'approval.resolved', runId: meta.runId, userId: meta.userId, data: { id: full.id, approved: decision, tool: req.tool } });
    return decision;
  }

  resolve(id: string, approved: boolean, _by = 'user'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(approved);
    return true;
  }

  /**
   * Resolve on behalf of an authenticated actor. Only the user whose run requested the
   * approval (or an admin) may decide it; anything else behaves like an unknown id.
   */
  resolveAs(id: string, approved: boolean, actor: { userId: string; role: string }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.req.userId !== actor.userId && actor.role !== 'admin') return false;
    if (p.req.requireAdmin && actor.role !== 'admin') return false;
    return this.resolve(id, approved, actor.userId);
  }

  /** Owner of a pending approval (undefined when unknown). */
  ownerOf(id: string): string | undefined {
    return this.pending.get(id)?.req.userId;
  }

  list(userId?: string): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !userId || r.userId === userId);
  }

  /** Deny everything pending for a run (used by /stop). */
  cancelRun(runId: string): void {
    for (const [id, p] of this.pending) if (p.req.runId === runId) this.resolve(id, false, 'cancelled');
  }
}
