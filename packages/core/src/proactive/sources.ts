/**
 * Proactive event sources.
 *
 * An {@link EventSource} turns something happening in the outside world into a {@link ProactiveEventInput}
 * fed to the {@link ProactiveService}. Two concrete, non-mocked sources ship:
 *   - {@link GatewayEmailSource} — reacts to real inbound email (and other gateway messages) by
 *     subscribing to the `gateway.inbound` bus event the existing email adapter already emits.
 *   - {@link WebhookSource} — a passive source for generic webhook/CI events (e.g. a failing build),
 *     fed by the HTTP route POST /api/proactive/events.
 */
import type { EventBus } from '../events/bus.js';
import type { ProactiveEventInput } from './service.js';

/** A source pushes events via the `emit` callback; `start` returns an unsubscribe function. */
export interface EventSource {
  readonly name: string;
  start(emit: (ev: ProactiveEventInput) => void): () => void;
  /** Optional active poll (e.g. check an inbox); returns the number of events produced. */
  poll?(emit: (ev: ProactiveEventInput) => void): Promise<number>;
}

/** Reacts to inbound gateway messages (email by default) and emits proactive events. */
export class GatewayEmailSource implements EventSource {
  readonly name = 'email';

  /** @param platforms gateway platforms to treat as proactive sources (default: just email). */
  constructor(private bus: EventBus, private platforms: string[] = ['email']) {}

  start(emit: (ev: ProactiveEventInput) => void): () => void {
    return this.bus.on('gateway.inbound', (e) => {
      const d = (e.data ?? {}) as { platform?: string; from?: string; displayName?: string; subject?: string; preview?: string };
      if (!d.platform || !this.platforms.includes(d.platform)) return;
      const who = d.displayName || d.from || 'someone';
      emit({
        source: this.name,
        kind: 'received',
        title: d.subject ? `Email from ${who}: ${d.subject}` : `New message from ${who}`,
        body: d.preview ?? '',
        data: { platform: d.platform, from: d.from },
      });
    });
  }
}

/**
 * Passive webhook/CI source. External systems POST events to /api/proactive/events; the route
 * forwards them to {@link ProactiveService.ingest}. This class exists so the source is registered
 * and discoverable (status, naming); it produces nothing on its own.
 */
export class WebhookSource implements EventSource {
  readonly name = 'webhook';
  start(): () => void {
    return () => undefined;
  }
}
