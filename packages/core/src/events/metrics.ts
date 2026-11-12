/**
 * Tiny metrics registry rendering the Prometheus text exposition format.
 * Counters and histograms are fed from the event bus (see `attachMetrics`).
 */
import type { EventBus } from './bus.js';

type Labels = Record<string, string>;
const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`)
    .join(',');

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private histograms = new Map<string, { help: string; buckets: number[]; values: Map<string, { counts: number[]; sum: number; n: number }> }>();

  inc(name: string, labels: Labels = {}, by = 1, help = name): void {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help, values: new Map() }));
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Labels = {}, help = name, buckets = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]): void {
    let h = this.histograms.get(name);
    if (!h) this.histograms.set(name, (h = { help, buckets, values: new Map() }));
    const k = key(labels);
    let v = h.values.get(k);
    if (!v) h.values.set(k, (v = { counts: buckets.map(() => 0), sum: 0, n: 0 }));
    h.buckets.forEach((b, i) => {
      if (value <= b) v!.counts[i]!++;
    });
    v.sum += value;
    v.n++;
  }

  get(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.values.get(key(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, h] of this.histograms) {
      lines.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
      for (const [k, v] of h.values) {
        const sep = k ? `${k},` : '';
        h.buckets.forEach((b, i) => lines.push(`${name}_bucket{${sep}le="${b}"} ${v.counts[i]}`));
        lines.push(`${name}_bucket{${sep}le="+Inf"} ${v.n}`, `${name}_sum${k ? `{${k}}` : ''} ${v.sum}`, `${name}_count${k ? `{${k}}` : ''} ${v.n}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Derive standard metrics from bus events. */
export function attachMetrics(bus: EventBus, m: Metrics): void {
  bus.on('*', (e) => {
    m.inc('mercury_events_total', { type: e.type }, 1, 'Events published on the bus');
    const d = e.data;
    if (e.type === 'llm.response') {
      m.inc('mercury_llm_tokens_total', { model: String(d.model), dir: 'input' }, Number(d.inputTokens ?? 0), 'LLM tokens');
      m.inc('mercury_llm_tokens_total', { model: String(d.model), dir: 'output' }, Number(d.outputTokens ?? 0), 'LLM tokens');
      if (typeof d.durationMs === 'number') m.observe('mercury_llm_latency_ms', d.durationMs, { model: String(d.model) }, 'LLM latency');
    }
    if (e.type === 'tool.result') {
      m.inc('mercury_tool_calls_total', { tool: String(d.name), ok: String(d.ok) }, 1, 'Tool calls');
      if (typeof d.durationMs === 'number') m.observe('mercury_tool_latency_ms', d.durationMs, { tool: String(d.name) }, 'Tool latency');
    }
    if (e.type === 'run.end') m.inc('mercury_runs_total', { status: String(d.status ?? 'ok') }, 1, 'Agent runs');
    if (e.type === 'guardrail' && d.blocked) m.inc('mercury_guardrail_blocks_total', { layer: String(d.layer) }, 1, 'Guardrail blocks');
    if (e.type === 'decision') m.inc('mercury_decisions_total', { purpose: String(d.purpose ?? 'adhoc'), provider: String(d.provider) }, 1, 'Decisions');
  });
}
