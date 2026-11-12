/**
 * Debug control points. When debugging is enabled (globally via config.debug or per
 * run), the agent pauses BEFORE each LLM call and/or tool call. A paused step can be
 * inspected, its payload edited (messages / tool arguments), then resumed or skipped
 * from the CLI (`/debug ...`) or the web UI debug panel.
 */
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../types/common.js';

export type BreakKind = 'llm' | 'tool';

export interface Breakpoints {
  llm: boolean;
  tool: boolean;
  /** Only pause on these tools (empty = all tools when `tool` is true). */
  tools: string[];
}

export interface PausedStep {
  id: string;
  runId: string;
  kind: BreakKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ResumeAction = { action: 'continue'; payload?: Record<string, unknown> } | { action: 'skip' } | { action: 'abort' };

export class DebugController {
  private global: Breakpoints;
  private perRun = new Map<string, Breakpoints>();
  private paused = new Map<string, { step: PausedStep; resolve: (a: ResumeAction) => void }>();

  constructor(private bus: EventBus, enabled = false) {
    this.global = { llm: enabled, tool: enabled, tools: [] };
  }

  setGlobal(bp: Partial<Breakpoints>): Breakpoints {
    this.global = { ...this.global, ...bp };
    return this.global;
  }
  getGlobal(): Breakpoints {
    return this.global;
  }
  setForRun(runId: string, bp: Partial<Breakpoints>): void {
    this.perRun.set(runId, { ...this.global, ...bp });
  }
  clearRun(runId: string): void {
    this.perRun.delete(runId);
    for (const [id, p] of this.paused) if (p.step.runId === runId) this.resume(id, { action: 'abort' });
  }

  private shouldPause(runId: string, kind: BreakKind, payload: Record<string, unknown>): boolean {
    const bp = this.perRun.get(runId) ?? this.global;
    if (kind === 'llm') return bp.llm;
    return bp.tool && (!bp.tools.length || bp.tools.includes(String(payload.tool)));
  }

  /** Called by the agent loop. Resolves immediately when no breakpoint applies. */
  async checkpoint(runId: string, kind: BreakKind, payload: Record<string, unknown>, signal?: AbortSignal): Promise<ResumeAction> {
    if (!this.shouldPause(runId, kind, payload)) return { action: 'continue' };
    const step: PausedStep = { id: newId('dbg'), runId, kind, payload, createdAt: nowIso() };
    this.bus.emit({ type: 'debug.paused', runId, data: { id: step.id, kind, payload } });
    return new Promise<ResumeAction>((resolve) => {
      this.paused.set(step.id, { step, resolve });
      signal?.addEventListener('abort', () => this.resume(step.id, { action: 'abort' }), { once: true });
    });
  }

  resume(id: string, action: ResumeAction = { action: 'continue' }): boolean {
    const p = this.paused.get(id);
    if (!p) return false;
    this.paused.delete(id);
    this.bus.emit({ type: 'debug.resumed', runId: p.step.runId, data: { id, action: action.action } });
    p.resolve(action);
    return true;
  }

  list(): PausedStep[] {
    return [...this.paused.values()].map((p) => p.step);
  }
}
