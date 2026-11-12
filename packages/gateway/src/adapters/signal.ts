/**
 * Signal adapter via the signal-cli REST API (bbernhard/signal-cli-rest-api).
 * Inbound: polls `GET /v1/receive/{number}`. Outbound: `POST /v2/send`.
 * Config: url (SIGNAL_API_URL, default http://localhost:8080), number (SIGNAL_NUMBER).
 */
import { BaseAdapter, chunkText } from '../base.js';
import type { InboundAttachment, OutboundMessage } from '../types.js';

interface SignalEnvelope {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: { message?: string; groupInfo?: { groupId: string }; attachments?: Array<{ id: string; contentType: string; filename?: string }> };
  };
}

export class SignalAdapter extends BaseAdapter {
  readonly type = 'signal';

  private get base(): string {
    return this.opt('url', 'SIGNAL_API_URL') ?? 'http://localhost:8080';
  }
  private get number(): string {
    return this.need('number', 'SIGNAL_NUMBER');
  }

  protected override async connect(): Promise<void> {
    this.state.detail = `polling ${this.base}`;
    this.poll((signal) => this.pollOnce(signal), Number(this.config.intervalMs ?? 2000));
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    const res = await this.deps.transport.request(`${this.base}/v1/receive/${encodeURIComponent(this.number)}`, { signal });
    for (const { envelope: e } of (await res.json<SignalEnvelope[]>()) ?? []) {
      const dm = e.dataMessage;
      const from = e.sourceNumber ?? e.source;
      if (!dm || !from) continue;
      const attachments: InboundAttachment[] = [];
      for (const a of dm.attachments ?? []) {
        const data = await (await this.deps.transport.request(`${this.base}/v1/attachments/${a.id}`)).buffer().catch(() => undefined);
        attachments.push({ name: a.filename ?? a.id, mime: a.contentType, data, voice: a.contentType.startsWith('audio/') });
      }
      const group = dm.groupInfo?.groupId;
      await this.receive({ userId: from, chatId: group ? `group.${group}` : from, text: dm.message ?? '', displayName: e.sourceName, messageId: String(e.timestamp ?? ''), attachments, isGroup: Boolean(group), mentioned: !group });
    }
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const message of chunkText(out.text, 4000)) {
      await this.deps.transport.request(`${this.base}/v2/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ number: this.number, recipients: [out.chatId], message }),
      });
    }
  }
}
