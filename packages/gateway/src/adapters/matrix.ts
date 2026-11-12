/**
 * Matrix client-server API adapter. Inbound: `/sync` long polling (skips the
 * initial backlog). Outbound: `PUT /rooms/{room}/send/m.room.message/{txn}`.
 * Config: homeserver (MATRIX_HOMESERVER), token (MATRIX_ACCESS_TOKEN), userId (bot's mxid).
 */
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage } from '../types.js';

interface SyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline?: { events?: Array<{ type: string; sender: string; event_id: string; content?: { msgtype?: string; body?: string } }> } }> };
}

export class MatrixAdapter extends BaseAdapter {
  readonly type = 'matrix';
  private since?: string;
  private txn = Date.now();

  private get base(): string {
    return `${this.need('homeserver', 'MATRIX_HOMESERVER').replace(/\/$/, '')}/_matrix/client/v3`;
  }
  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.need('token', 'MATRIX_ACCESS_TOKEN')}`, 'content-type': 'application/json' };
  }

  protected override async connect(): Promise<void> {
    // Initial sync with timeout=0 just to obtain a `since` token (don't answer old messages).
    const first = await (await this.deps.transport.request(`${this.base}/sync?timeout=0`, { headers: this.headers })).json<SyncResponse>();
    this.since = first.next_batch;
    this.state.detail = 'sync long polling';
    this.poll((signal) => this.pollOnce(signal));
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    const url = `${this.base}/sync?timeout=25000${this.since ? `&since=${encodeURIComponent(this.since)}` : ''}`;
    const data = await (await this.deps.transport.request(url, { headers: this.headers, signal, timeoutMs: 35_000 })).json<SyncResponse>();
    this.since = data.next_batch;
    for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
      for (const ev of room.timeline?.events ?? []) {
        if (ev.type !== 'm.room.message' || ev.sender === this.opt('userId') || !ev.content?.body) continue;
        await this.receive({ userId: ev.sender, chatId: roomId, text: ev.content.body, messageId: ev.event_id });
      }
    }
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const body of chunkText(out.text, 16_000)) {
      const url = `${this.base}/rooms/${encodeURIComponent(out.chatId)}/send/m.room.message/m${this.txn++}`;
      await this.deps.transport.request(url, { method: 'PUT', headers: this.headers, body: JSON.stringify({ msgtype: 'm.text', body }) });
    }
  }
}
