/**
 * Facebook Messenger adapter (Meta Graph API). Inbound: Messenger Platform
 * webhook (GET verify handshake + POST events signed with X-Hub-Signature-256).
 * Outbound: Graph API `/{pageId}/messages` Send API. Two-way chat with a Page.
 * Config: pageId (FACEBOOK_PAGE_ID), token — Page access token (FACEBOOK_PAGE_TOKEN),
 * verifyToken (FACEBOOK_VERIFY_TOKEN), appSecret (FACEBOOK_APP_SECRET), apiBase.
 */
import { verifyHmacSignature } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

interface FbMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
}
interface FbPayload {
  object?: string;
  entry?: Array<{ messaging?: FbMessaging[] }>;
}

export class FacebookAdapter extends BaseAdapter {
  readonly type = 'facebook';

  private get api(): string {
    return this.opt('apiBase') ?? 'https://graph.facebook.com/v21.0';
  }

  protected override async connect(): Promise<void> {
    this.need('pageId', 'FACEBOOK_PAGE_ID');
    this.need('token', 'FACEBOOK_PAGE_TOKEN');
    this.state.detail = 'Messenger Platform webhook';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    // Meta verification handshake.
    if (req.method === 'GET') {
      const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === this.opt('verifyToken', 'FACEBOOK_VERIFY_TOKEN');
      return ok ? { status: 200, body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' } : { status: 403, body: 'forbidden' };
    }
    const secret = this.opt('appSecret', 'FACEBOOK_APP_SECRET');
    // Fail closed: without an app secret, inbound POSTs cannot be authenticated. Set
    // `allowUnsigned: true` only for local testing.
    if (!secret) {
      if (this.config.allowUnsigned !== true && this.opt('allowUnsigned') !== 'true') return { status: 401, body: 'webhook signature verification is not configured (appSecret missing)' };
    } else if (!verifyHmacSignature(secret, req.body, req.headers['x-hub-signature-256'])) return { status: 401, body: 'invalid signature' };
    const payload = JSON.parse(req.body) as FbPayload;
    if (payload.object !== 'page') return { status: 200, body: { ok: true } };
    for (const m of payload.entry?.flatMap((e) => e.messaging ?? []) ?? []) {
      // Skip echoes of our own outgoing messages and events without text.
      if (!m.sender?.id || m.message?.is_echo || !m.message?.text) continue;
      void this.receive({ userId: m.sender.id, chatId: m.sender.id, text: m.message.text, messageId: m.message.mid });
    }
    return { status: 200, body: { ok: true } };
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const text of chunkText(out.text, 1900)) {
      await this.deps.transport.request(`${this.api}/${this.need('pageId', 'FACEBOOK_PAGE_ID')}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.need('token', 'FACEBOOK_PAGE_TOKEN')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: out.chatId }, messaging_type: 'RESPONSE', message: { text } }),
      });
    }
  }
}
