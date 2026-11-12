/**
 * Mattermost adapter. Inbound: outgoing webhook (form or JSON POST with a
 * shared token). Outbound: REST `POST /api/v4/posts` with a bot token.
 * Config: url (MATTERMOST_URL), token (MATTERMOST_TOKEN), webhookToken.
 */
import { safeEqual } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

export class MattermostAdapter extends BaseAdapter {
  readonly type = 'mattermost';

  protected override async connect(): Promise<void> {
    this.need('url', 'MATTERMOST_URL');
    this.state.detail = 'outgoing webhook + REST';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const p: Record<string, string> = isJson ? (JSON.parse(req.body) as Record<string, string>) : Object.fromEntries(new URLSearchParams(req.body));
    if (!safeEqual(p.token ?? '', this.need('webhookToken'))) return { status: 401, body: 'invalid token' };
    if (p.user_id && p.channel_id) {
      const text = (p.text ?? '').replace(new RegExp(`^${p.trigger_word ?? ''}\\s*`), '');
      void this.receive({ userId: p.user_id, chatId: p.channel_id, text, displayName: p.user_name, messageId: p.post_id });
    }
    return { status: 200, body: {} };
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const message of chunkText(out.text, 15_000)) {
      await this.deps.transport.request(`${this.need('url', 'MATTERMOST_URL').replace(/\/$/, '')}/api/v4/posts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.need('token', 'MATTERMOST_TOKEN')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel_id: out.chatId, message, root_id: out.replyTo }),
      });
    }
  }
}
