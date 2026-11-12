/**
 * Home Assistant adapter.
 * Inbound: an HA automation POSTs `{user, text, chat?}` to `/webhooks/<name>`
 * authenticated with `Authorization: Bearer <webhookSecret>`.
 * Outbound: calls the notify service (`POST /api/services/notify/<service>`).
 * The agent can also control devices through the `http_request` tool with the
 * HA token (documented in docs/help/integrations.md).
 * Config: url (HASS_URL), token (HASS_TOKEN), notifyService (default "notify"), webhookSecret.
 */
import { safeEqual } from '@mercury/core';
import { BaseAdapter } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

export class HomeAssistantAdapter extends BaseAdapter {
  readonly type = 'homeassistant';

  protected override async connect(): Promise<void> {
    this.need('url', 'HASS_URL');
    this.state.detail = 'webhook + notify service';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const secret = this.need('webhookSecret', 'HASS_WEBHOOK_SECRET');
    if (!safeEqual(req.headers['authorization'] ?? '', `Bearer ${secret}`)) return { status: 401, body: 'unauthorized' };
    const body = JSON.parse(req.body || '{}') as { user?: string; text?: string; chat?: string };
    if (!body.text) return { status: 400, body: 'text is required' };
    const user = body.user ?? 'homeassistant';
    void this.receive({ userId: user, chatId: body.chat ?? user, text: body.text });
    return { status: 202, body: { accepted: true } };
  }

  async send(out: OutboundMessage): Promise<void> {
    const service = this.opt('notifyService') ?? 'notify';
    await this.deps.transport.request(`${this.need('url', 'HASS_URL').replace(/\/$/, '')}/api/services/notify/${service}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.need('token', 'HASS_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Mercury', message: out.text, data: { chat: out.chatId } }),
    });
  }
}
