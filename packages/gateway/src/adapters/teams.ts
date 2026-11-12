/**
 * Microsoft Teams adapter using an *outgoing webhook* (HMAC-signed, configured
 * per team) for inbound and an *incoming webhook* URL for proactive outbound.
 * Replies to outgoing-webhook calls are returned synchronously in the response
 * (Teams requires an answer within ~5 s, so long agent runs fall back to the
 * incoming webhook). Full Bot Framework support is out of scope (see STATUS.md).
 * Config: securityToken (base64 HMAC key from Teams), incomingWebhookUrl, syncTimeoutMs.
 */
import { verifyTeamsSignature } from '@mercury/core';
import { BaseAdapter } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

interface TeamsActivity {
  text?: string;
  from?: { id: string; name?: string };
  conversation?: { id: string };
  id?: string;
}

export class TeamsAdapter extends BaseAdapter {
  readonly type = 'teams';
  private waiting = new Map<string, (text: string) => void>();

  protected override async connect(): Promise<void> {
    this.need('securityToken', 'TEAMS_SECURITY_TOKEN');
    this.state.detail = 'outgoing/incoming webhooks';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!verifyTeamsSignature(this.need('securityToken', 'TEAMS_SECURITY_TOKEN'), req.body, req.headers['authorization'])) {
      return { status: 401, body: 'invalid signature' };
    }
    const act = JSON.parse(req.body) as TeamsActivity;
    if (!act.from || !act.conversation) return { status: 400, body: 'bad activity' };
    const chatId = act.conversation.id;
    const text = (act.text ?? '').replace(/<at>[^<]*<\/at>\s*/g, '').replace(/<[^>]+>/g, '').trim();
    const reply = new Promise<string>((resolve) => this.waiting.set(chatId, resolve));
    void this.receive({ userId: act.from.id, chatId, text, displayName: act.from.name, messageId: act.id });
    const timeout = new Promise<string>((r) => setTimeout(() => r(''), Number(this.config.syncTimeoutMs ?? 4500)));
    const answer = await Promise.race([reply, timeout]);
    this.waiting.delete(chatId);
    return { status: 200, body: { type: 'message', text: answer || 'Working on it — the answer will follow in this channel.' } };
  }

  async send(out: OutboundMessage): Promise<void> {
    const waiter = this.waiting.get(out.chatId);
    if (waiter) return waiter(out.text);
    const url = this.opt('incomingWebhookUrl', 'TEAMS_INCOMING_WEBHOOK_URL');
    if (!url) throw new Error('teams: no incomingWebhookUrl configured for proactive messages');
    await this.deps.transport.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: out.text }) });
  }
}
