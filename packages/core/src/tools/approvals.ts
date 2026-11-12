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

export class ApprovalService {
  private pending = new Map<string, { req: PendingApproval; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, ApprovalHandler>();

  constructor(private bus: EventBus, private timeoutMs = 5 * 60_000) {}

  /** Register an interactive handler for a platform (e.g. "cli"). */
  setHandler(platform: string, handler: ApprovalHandler | undefined): void {
    if (handler) this.handlers.set(platform, handler);
    else this.handlers.delete(platform);
  }

  async request(req: ApprovalRequest, meta: { runId?: string; userId: string; platform: string }): Promise<boolean> {
    const full: PendingApproval = { ...req, ...meta, id: newId('apr'), createdAt: new Date().toISOString() };
    this.bus.emit({ type: 'approval.request', runId: meta.runId, userId: meta.userId, data: { ...full } });
    const handler = this.handlers.get(meta.platform);
    const decision = handler
      ? await handler(full).catch(() => false)
      : await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => this.resolve(full.id, false, 'timeout'), this.timeoutMs);
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

  list(userId?: string): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !userId || r.userId === userId);
  }

  /** Deny everything pending for a run (used by /stop). */
  cancelRun(runId: string): void {
    for (const [id, p] of this.pending) if (p.req.runId === runId) this.resolve(id, false, 'cancelled');
  }
}
