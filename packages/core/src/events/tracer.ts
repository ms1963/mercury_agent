/**
 * Minimal trace/span model. Spans are emitted as `span.start`/`span.end` events and
 * can optionally be exported to an OpenTelemetry collector (OTLP/HTTP JSON).
 */
import { randomBytes } from 'node:crypto';
import type { EventBus } from './bus.js';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, unknown>;
  status: 'ok' | 'error';
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export class Tracer {
  private finished: Span[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private bus: EventBus,
    private otlpEndpoint?: string,
  ) {}

  start(name: string, opts: { traceId?: string; parent?: Span; runId?: string; attributes?: Record<string, unknown> } = {}): Span {
    const span: Span = {
      traceId: opts.parent?.traceId ?? opts.traceId ?? hex(16),
      spanId: hex(8),
      parentSpanId: opts.parent?.spanId,
      name,
      startMs: Date.now(),
      attributes: opts.attributes ?? {},
      status: 'ok',
    };
    this.bus.emit({ type: 'span.start', runId: opts.runId, spanId: span.spanId, parentSpanId: span.parentSpanId, data: { name, traceId: span.traceId } });
    return span;
  }

  end(span: Span, status: 'ok' | 'error' = 'ok', runId?: string): void {
    span.endMs = Date.now();
    span.status = status;
    this.bus.emit({
      type: 'span.end',
      runId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      data: { name: span.name, durationMs: span.endMs - span.startMs, status },
    });
    if (this.otlpEndpoint) {
      this.finished.push(span);
      this.flushTimer ??= setTimeout(() => void this.flush(), 2000);
    }
  }

  /** Export finished spans as OTLP JSON. Failures are swallowed (observability must not break runs). */
  async flush(): Promise<void> {
    this.flushTimer = undefined;
    if (!this.otlpEndpoint || this.finished.length === 0) return;
    const spans = this.finished.splice(0);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'mercury' } }] },
          scopeSpans: [
            {
              scope: { name: 'mercury' },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId,
                name: s.name,
                kind: 1,
                startTimeUnixNano: String(s.startMs * 1e6),
                endTimeUnixNano: String((s.endMs ?? s.startMs) * 1e6),
                status: { code: s.status === 'ok' ? 1 : 2 },
                attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
              })),
            },
          ],
        },
      ],
    };
    try {
      await fetch(`${this.otlpEndpoint.replace(/\/$/, '')}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      /* ignore */
    }
  }
}
