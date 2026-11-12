/**
 * SMS adapter via Twilio. Inbound: Twilio messaging webhook (form POST, verified
 * with X-Twilio-Signature). Outbound: Messages REST API.
 * Config: accountSid (TWILIO_ACCOUNT_SID), authToken (TWILIO_AUTH_TOKEN), from
 * (TWILIO_FROM), webhookUrl (exact public URL Twilio calls — needed for signatures).
 */
import { verifyTwilioSignature } from '@mercury/core';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

export class SmsAdapter extends BaseAdapter {
  readonly type = 'sms';

  protected override async connect(): Promise<void> {
    this.need('accountSid', 'TWILIO_ACCOUNT_SID');
    this.state.detail = 'Twilio webhook + REST';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const params = Object.fromEntries(new URLSearchParams(req.body));
    const url = this.opt('webhookUrl') ?? `${this.deps.publicUrl ?? ''}/webhooks/${this.name}`;
    if (!verifyTwilioSignature(this.need('authToken', 'TWILIO_AUTH_TOKEN'), url, params, req.headers['x-twilio-signature'])) {
      return { status: 401, body: 'invalid signature' };
    }
    if (params.From) void this.receive({ userId: params.From, chatId: params.From, text: params.Body ?? '', messageId: params.MessageSid });
    // Empty TwiML: the reply is sent asynchronously through the REST API.
    return { status: 200, body: '<Response></Response>', contentType: 'text/xml' };
  }

  async send(out: OutboundMessage): Promise<void> {
    const sid = this.need('accountSid', 'TWILIO_ACCOUNT_SID');
    const auth = Buffer.from(`${sid}:${this.need('authToken', 'TWILIO_AUTH_TOKEN')}`).toString('base64');
    for (const Body of chunkText(out.text, 1500)) {
      await this.deps.transport.request(`${this.opt('apiBase') ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: out.chatId, From: this.need('from', 'TWILIO_FROM'), Body }).toString(),
      });
    }
  }
}
