/**
 * Discord adapter.
 * Outbound: REST `POST /channels/{id}/messages` with the bot token (2000-char chunks).
 * Inbound: HTTP interactions endpoint (`/webhooks/<name>`), verified with the
 * application's Ed25519 public key. Slash command `/ask text:<...>` is turned into
 * a message. (A persistent Gateway websocket for reading all channel messages is
 * not implemented — see STATUS.md.)
 * Config: token (DISCORD_BOT_TOKEN), publicKey (DISCORD_PUBLIC_KEY), apiBase.
 */
import { createPublicKey, verify } from 'node:crypto';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage, WebhookRequest, WebhookResponse } from '../types.js';

/** Verify a Discord interaction signature (Ed25519 over timestamp + body). */
export function verifyDiscordSignature(publicKeyHex: string, body: string, signatureHex?: string, timestamp?: string): boolean {
  if (!signatureHex || !timestamp) return false;
  try {
    // Wrap the raw 32-byte key in a SPKI DER header so node:crypto accepts it.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

interface Interaction {
  type: number;
  channel_id?: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  data?: { name: string; options?: Array<{ name: string; value: string }> };
}

export class DiscordAdapter extends BaseAdapter {
  readonly type = 'discord';

  private get api(): string {
    return this.opt('apiBase') ?? 'https://discord.com/api/v10';
  }

  protected override async connect(): Promise<void> {
    this.need('token', 'DISCORD_BOT_TOKEN');
    this.state.detail = 'interactions webhook + REST';
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const key = this.opt('publicKey', 'DISCORD_PUBLIC_KEY');
    if (!key || !verifyDiscordSignature(key, req.body, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
      return { status: 401, body: 'invalid signature' };
    }
    const it = JSON.parse(req.body) as Interaction;
    if (it.type === 1) return { status: 200, body: { type: 1 } }; // PING
    const user = it.member?.user ?? it.user;
    const text = it.data?.options?.map((o) => o.value).join(' ') ?? '';
    if (user && it.channel_id) {
      void this.receive({ userId: user.id, chatId: it.channel_id, text, displayName: user.username });
    }
    // Deferred acknowledgement: the answer arrives later as a normal channel message.
    return { status: 200, body: { type: 5 } };
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const content of chunkText(out.text, 2000)) {
      await this.deps.transport.request(`${this.api}/channels/${out.chatId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.need('token', 'DISCORD_BOT_TOKEN')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    }
  }
}
