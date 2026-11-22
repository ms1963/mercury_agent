/**
 * WhatsApp Business Cloud API adapter. Inbound: Meta webhook (GET verify
 * handshake + POST events signed with X-Hub-Signature-256). Outbound: Graph API
 * `/{phoneNumberId}/messages`. Voice notes are fetched via the media endpoint.
 * Config: token (WHATSAPP_TOKEN), phoneNumberId, verifyToken, appSecret, apiBase.
 */
import { verifyHmacSignature } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { InboundAttachment, OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  image?: { id: string; mime_type?: string; caption?: string };
}
interface WaPayload {
  entry?: Array<{ changes?: Array<{ value?: { messages?: WaMessage[]; contacts?: Array<{ profile?: { name?: string } }> } }> }>;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly type = 'whatsapp';

  private get api(): string {
    return this.opt('apiBase') ?? 'https://graph.facebook.com/v21.0';
  }
  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.need('token', 'WHATSAPP_TOKEN')}` };
  }

  protected override async connect(): Promise<void> {
    this.need('phoneNumberId', 'WHATSAPP_PHONE_NUMBER_ID');
    this.state.detail = 'Cloud API webhook';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method === 'GET') {
      const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === this.opt('verifyToken', 'WHATSAPP_VERIFY_TOKEN');
      return ok ? { status: 200, body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' } : { status: 403, body: 'forbidden' };
    }
    const secret = this.opt('appSecret', 'WHATSAPP_APP_SECRET');
    // Fail closed: without an app secret, inbound POSTs cannot be authenticated. Set
    // `allowUnsigned: true` only for local testing.
    if (!secret) {
      if (this.config.allowUnsigned !== true && this.opt('allowUnsigned') !== 'true') return { status: 401, body: 'webhook signature verification is not configured (appSecret missing)' };
    } else if (!verifyHmacSignature(secret, req.body, req.headers['x-hub-signature-256'])) return { status: 401, body: 'invalid signature' };
    const payload = JSON.parse(req.body) as WaPayload;
    for (const change of payload.entry?.flatMap((e) => e.changes ?? []) ?? []) {
      const name = change.value?.contacts?.[0]?.profile?.name;
      for (const m of change.value?.messages ?? []) void this.handle(m, name);
    }
    return { status: 200, body: { ok: true } };
  }

  private async handle(m: WaMessage, name?: string): Promise<void> {
    const attachments: InboundAttachment[] = [];
    const media = m.audio ?? m.image;
    if (media) {
      const data = await this.media(media.id).catch(() => undefined);
      attachments.push({ name: m.audio ? 'voice.ogg' : 'image.jpg', mime: media.mime_type, data, voice: Boolean(m.audio) });
    }
    await this.receive({ userId: m.from, chatId: m.from, text: m.text?.body ?? m.image?.caption ?? '', displayName: name, messageId: m.id, attachments });
  }

  private async media(id: string): Promise<Buffer> {
    const info = await (await this.deps.transport.request(`${this.api}/${id}`, { headers: this.auth })).json<{ url: string }>();
    return (await this.deps.transport.request(info.url, { headers: this.auth })).buffer();
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const body of chunkText(out.text, 4000)) {
      await this.deps.transport.request(`${this.api}/${this.need('phoneNumberId', 'WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
        method: 'POST',
        headers: { ...this.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: out.chatId, type: 'text', text: { body } }),
      });
    }
  }
}
