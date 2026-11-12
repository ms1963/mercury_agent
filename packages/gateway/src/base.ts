/** BaseAdapter: shared plumbing (config access, status, chunking, polling loops). */
import type { Adapter, AdapterDeps, AdapterStatus, InboundMessage, InboundSink, OutboundMessage } from './types.js';

/** Split long text into platform-sized chunks, preferring paragraph/line boundaries. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export abstract class BaseAdapter implements Adapter {
  abstract readonly type: string;
  readonly textOnly: boolean = true;
  protected sink?: InboundSink;
  protected state: AdapterStatus = { connected: false };
  private loops: AbortController[] = [];

  constructor(readonly name: string, protected config: Record<string, unknown>, protected deps: AdapterDeps) {}

  /** Read a config value, falling back to an environment variable. */
  protected opt(key: string, env?: string): string | undefined {
    const v = this.config[key];
    if (typeof v === 'string' && v) return v;
    return env ? process.env[env] : undefined;
  }

  protected need(key: string, env?: string): string {
    const v = this.opt(key, env);
    if (!v) throw new Error(`${this.name}: missing config "${key}"${env ? ` (or env ${env})` : ''}`);
    return v;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    await this.connect();
    this.state = { ...this.state, connected: true, error: undefined };
  }

  async stop(): Promise<void> {
    this.loops.forEach((c) => c.abort());
    this.loops = [];
    await this.disconnect();
    this.state = { ...this.state, connected: false };
  }

  status(): AdapterStatus {
    return this.state;
  }

  /** Push an inbound message to the gateway. */
  protected async receive(msg: Omit<InboundMessage, 'platform'>): Promise<void> {
    this.state.lastActivity = new Date().toISOString();
    await this.sink?.({ ...msg, platform: this.name });
  }

  /** Run `fn` repeatedly until stop() (long polling). Errors back off exponentially. */
  protected poll(fn: (signal: AbortSignal) => Promise<void>, intervalMs = 0): void {
    const controller = new AbortController();
    this.loops.push(controller);
    void (async () => {
      let backoff = 1000;
      while (!controller.signal.aborted) {
        try {
          await fn(controller.signal);
          backoff = 1000;
          if (intervalMs) await new Promise((r) => setTimeout(r, intervalMs));
        } catch (err) {
          if (controller.signal.aborted) break;
          this.state.error = String(err);
          this.deps.logger.warn(`${this.name} poll failed`, { error: String(err) });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  protected async connect(): Promise<void> {
    /* override */
  }
  protected async disconnect(): Promise<void> {
    /* override */
  }

  abstract send(out: OutboundMessage): Promise<void>;
}
