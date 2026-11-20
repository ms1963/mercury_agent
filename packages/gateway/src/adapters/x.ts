/**
 * X (formerly Twitter) adapter — direct messages. Inbound: Account Activity API
 * webhook, which first issues a CRC GET challenge (answered with a base64 HMAC of
 * the crc_token) and then POSTs direct_message_events signed with the
 * `x-twitter-webhooks-signature` header. Outbound: API v2 DM endpoint
 * `/2/dm_conversations/with/:id/messages` with an OAuth2 bearer token.
 * Config: consumerSecret — API/consumer secret used for CRC + signature
 * (X_CONSUMER_SECRET), token — OAuth2 user bearer token for sending (X_BEARER_TOKEN),
 * botUserId — own numeric user id to ignore self DMs (X_BOT_USER_ID), apiBase.
 */
import { hmacBase64, verifyXSignature } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

interface XdmEvent {
  type?: string;
  message_create?: { sender_id?: string; target?: { recipient_id?: string }; message_data?: { text?: string } };
  id?: string;
}
interface XPayload {
  for_user_id?: string;
  direct_message_events?: XdmEvent[];
  users?: Record<string, { screen_name?: string; name?: string }>;
}

export class XAdapter extends BaseAdapter {
  readonly type = 'x';

  private get api(): string {
    return this.opt('apiBase') ?? 'https://api.twitter.com';
  }

  protected override async connect(): Promise<void> {
    this.need('consumerSecret', 'X_CONSUMER_SECRET');
    this.need('token', 'X_BEARER_TOKEN');
    this.state.detail = 'Account Activity API webhook';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const secret = this.need('consumerSecret', 'X_CONSUMER_SECRET');
    // CRC (Challenge-Response Check): echo a base64 HMAC of the token.
    if (req.method === 'GET') {
      const token = req.query['crc_token'];
      if (!token) return { status: 400, body: 'missing crc_token' };
      return { status: 200, body: { response_token: `sha256=${hmacBase64(secret, token)}` } };
    }
    if (!verifyXSignature(secret, req.body, req.headers['x-twitter-webhooks-signature'])) return { status: 401, body: 'invalid signature' };
    const payload = JSON.parse(req.body) as XPayload;
    const me = this.opt('botUserId', 'X_BOT_USER_ID');
    for (const ev of payload.direct_message_events ?? []) {
      const mc = ev.message_create;
      const sender = mc?.sender_id;
      const text = mc?.message_data?.text;
      // Ignore our own outgoing DMs to avoid loops.
      if (ev.type !== 'message_create' || !sender || sender === me || !text) continue;
      void this.receive({ userId: sender, chatId: sender, text, displayName: payload.users?.[sender]?.screen_name, messageId: ev.id });
    }
    return { status: 200, body: { ok: true } };
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const text of chunkText(out.text, 9500)) {
      await this.deps.transport.request(`${this.api}/2/dm_conversations/with/${out.chatId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.need('token', 'X_BEARER_TOKEN')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }
  }
}
