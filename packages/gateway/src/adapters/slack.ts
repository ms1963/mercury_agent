/**
 * Slack adapter. Inbound: Events API (`/webhooks/<name>`) with signing-secret
 * verification and url_verification handshake. Outbound: chat.postMessage.
 * Config: token (SLACK_BOT_TOKEN), signingSecret (SLACK_SIGNING_SECRET), apiBase.
 */
import { verifySlackSignature } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: { type: string; user?: string; text?: string; channel?: string; channel_type?: string; bot_id?: string; ts?: string };
}

export class SlackAdapter extends BaseAdapter {
  readonly type = 'slack';

  protected override async connect(): Promise<void> {
    this.need('token', 'SLACK_BOT_TOKEN');
    this.state.detail = 'Events API webhook';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const secret = this.need('signingSecret', 'SLACK_SIGNING_SECRET');
    if (!verifySlackSignature(secret, req.body, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'])) {
      return { status: 401, body: 'invalid signature' };
    }
    const payload = JSON.parse(req.body) as SlackEvent;
    if (payload.type === 'url_verification') return { status: 200, body: { challenge: payload.challenge } };
    const ev = payload.event;
    // Ignore bot messages (including our own) to avoid loops.
    if (ev && (ev.type === 'message' || ev.type === 'app_mention') && !ev.bot_id && ev.user && ev.channel) {
      const isGroup = ev.channel_type !== 'im';
      void this.receive({ userId: ev.user, chatId: ev.channel, text: (ev.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, ''), messageId: ev.ts, isGroup, mentioned: !isGroup || ev.type === 'app_mention' });
    }
    return { status: 200, body: { ok: true } };
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const text of chunkText(out.text, 3500)) {
      await this.deps.transport.request(`${this.opt('apiBase') ?? 'https://slack.com/api'}/chat.postMessage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.need('token', 'SLACK_BOT_TOKEN')}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: out.chatId, text, thread_ts: out.replyTo }),
      });
    }
  }
}
