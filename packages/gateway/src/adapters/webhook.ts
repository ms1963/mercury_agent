/**
 * Generic webhook adapter — the simplest way to connect any system.
 * Inbound: `POST /webhooks/<name>` with JSON `{user, text, chat?}` and header
 * `X-Mercury-Signature: sha256=<hmac(secret, body)>`.
 * Outbound: POSTs `{chat, text}` to `outboundUrl` (signed the same way), if set.
 * With `sync: true` the reply is returned in the HTTP response instead.
 * Config: secret (required), outboundUrl, sync.
 */
import { hmacHex, verifyHmacSignature } from '@mercury/core';
import { BaseAdapter } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

export class WebhookAdapter extends BaseAdapter {
  readonly type = 'webhook';
  override readonly textOnly = false;
  /** Pending synchronous requests, keyed by chat id. */
  private waiting = new Map<string, (text: string) => void>();

  protected override async connect(): Promise<void> {
    this.need('secret');
    this.state.detail = this.opt('outboundUrl') ? `outbound → ${this.opt('outboundUrl')}` : this.config.sync ? 'synchronous replies' : 'inbound only';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!verifyHmacSignature(this.need('secret'), req.body, req.headers['x-mercury-signature'])) return { status: 401, body: 'invalid signature' };
    const body = JSON.parse(req.body || '{}') as { user?: string; text?: string; chat?: string };
    if (!body.user || !body.text) return { status: 400, body: 'user and text are required' };
    const chatId = body.chat ?? body.user;
    if (!this.config.sync) {
      void this.receive({ userId: body.user, chatId, text: body.text });
      return { status: 202, body: { accepted: true } };
    }
    const reply = new Promise<string>((resolve) => this.waiting.set(chatId, resolve));
    void this.receive({ userId: body.user, chatId, text: body.text });
    const timeout = new Promise<string>((r) => setTimeout(() => r(''), Number(this.config.timeoutMs ?? 120_000)));
    const text = await Promise.race([reply, timeout]);
    this.waiting.delete(chatId);
    return text ? { status: 200, body: { text } } : { status: 504, body: { error: 'timeout' } };
  }

  async send(out: OutboundMessage): Promise<void> {
    const waiter = this.waiting.get(out.chatId);
    if (waiter) return waiter(out.text);
    const url = this.opt('outboundUrl');
    if (!url) return;
    const body = JSON.stringify({ chat: out.chatId, text: out.text });
    await this.deps.transport.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mercury-signature': `sha256=${hmacHex(this.need('secret'), body)}` },
      body,
    });
  }
}
