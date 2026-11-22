/**
 * Web chat adapter: an embeddable chat widget channel served by Mercury itself
 * (`POST /webhooks/<name>` with `{visitor, text}`; replies are queued per
 * visitor and fetched with `GET /webhooks/<name>?visitor=<id>`). No external
 * service needed. Visitors are anonymous platform users, so pairing rules apply.
 * Config: origin (allowed CORS origin, optional).
 */
import { BaseAdapter } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

export class WebChatAdapter extends BaseAdapter {
  readonly type = 'webchat';
  override readonly textOnly = false;
  private outbox = new Map<string, string[]>();

  protected override async connect(): Promise<void> {
    this.state.detail = 'built-in widget endpoint';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method === 'GET') {
      const visitor = req.query.visitor ?? '';
      // The visitor id is the only secret for polling replies: require a long, unguessable id.
      if (!/^[\w-]{16,128}$/.test(visitor)) return { status: 400, body: 'visitor must be a random id of 16-128 chars' };
      const messages = this.outbox.get(visitor) ?? [];
      this.outbox.delete(visitor);
      return { status: 200, body: { messages } };
    }
    const body = JSON.parse(req.body || '{}') as { visitor?: string; text?: string; name?: string };
    if (!body.visitor || !/^[\w-]{16,128}$/.test(body.visitor) || !body.text) return { status: 400, body: 'visitor (random id, 16-128 chars) and text are required' };
    void this.receive({ userId: body.visitor, chatId: body.visitor, text: body.text.slice(0, 8000), displayName: body.name });
    return { status: 202, body: { accepted: true } };
  }

  async send(out: OutboundMessage): Promise<void> {
    const box = this.outbox.get(out.chatId) ?? [];
    box.push(out.text);
    this.outbox.set(out.chatId, box.slice(-50));
  }
}
