/**
 * In-process event bus. Every agent step (thought, LLM call, tool call, memory op,
 * decision, guardrail verdict...) is published here. Subscribers include the trace
 * recorder, metrics, SSE streams for the UI, plugins and hooks.
 */
import { newId, nowIso } from '../types/common.js';

export type EventType =
  | 'run.start'
  | 'run.end'
  | 'run.error'
  | 'thought'
  | 'llm.request'
  | 'llm.delta'
  | 'llm.response'
  | 'llm.error'
  | 'tool.call'
  | 'tool.result'
  | 'tool.denied'
  | 'approval.request'
  | 'approval.resolved'
  | 'memory.write'
  | 'memory.read'
  | 'memory.delete'
  | 'decision'
  | 'guardrail'
  | 'reflection'
  | 'skill.created'
  | 'skill.updated'
  | 'subagent.spawn'
  | 'subagent.end'
  | 'workflow.start'
  | 'workflow.step'
  | 'workflow.end'
  | 'debug.paused'
  | 'debug.resumed'
  | 'schedule.run'
  | 'gateway.inbound'
  | 'gateway.outbound'
  | 'span.start'
  | 'span.end'
  | 'log'
  | (string & {});

export interface MercuryEvent {
  id: string;
  type: EventType;
  ts: string;
  runId?: string;
  sessionId?: string;
  userId?: string;
  spanId?: string;
  parentSpanId?: string;
  data: Record<string, unknown>;
}

export type EventInput = Omit<MercuryEvent, 'id' | 'ts'> & Partial<Pick<MercuryEvent, 'id' | 'ts'>>;
export type EventHandler = (event: MercuryEvent) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to one type, a prefix ("tool.*") or everything ("*"). Returns an unsubscribe fn. */
  on(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(input: EventInput): MercuryEvent {
    const event: MercuryEvent = { id: input.id ?? newId('ev'), ts: input.ts ?? nowIso(), ...input, data: input.data ?? {} };
    const prefix = event.type.includes('.') ? `${event.type.split('.')[0]}.*` : undefined;
    for (const key of [event.type, prefix, '*']) {
      if (!key) continue;
      for (const h of this.handlers.get(key) ?? []) {
        try {
          h(event);
        } catch (err) {
          // A broken subscriber must never break the agent loop.
          console.error(`[eventbus] handler for ${key} failed:`, err);
        }
      }
    }
    return event;
  }

  /** Resolve with the first event matching the predicate (used by tests and approvals). */
  waitFor(type: string, predicate: (e: MercuryEvent) => boolean = () => true, timeoutMs = 10_000): Promise<MercuryEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const off = this.on(type, (e) => {
        if (!predicate(e)) return;
        clearTimeout(timer);
        off();
        resolve(e);
      });
    });
  }
}
