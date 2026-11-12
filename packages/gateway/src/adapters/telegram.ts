/**
 * Telegram Bot API adapter. Inbound: long polling via getUpdates (no public URL
 * needed). Outbound: sendMessage (4096-char chunks). Voice memos and photos are
 * downloaded through getFile and handed to the gateway as attachments.
 * Config: token (or TELEGRAM_BOT_TOKEN), apiBase (optional, for tests/proxies).
 */
import { BaseAdapter, chunkText } from '../base.js';
import type { InboundAttachment, OutboundMessage } from '../types.js';

interface TgFile {
  file_id: string;
  mime_type?: string;
  file_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  voice?: TgFile;
  audio?: TgFile;
  document?: TgFile;
  photo?: TgFile[];
  entities?: Array<{ type: string }>;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export class TelegramAdapter extends BaseAdapter {
  readonly type = 'telegram';
  private offset = 0;

  private get api(): string {
    return `${this.opt('apiBase') ?? 'https://api.telegram.org'}/bot${this.need('token', 'TELEGRAM_BOT_TOKEN')}`;
  }

  protected override async connect(): Promise<void> {
    const me = await this.deps.transport.request(`${this.api}/getMe`);
    if (!me.ok) throw new Error(`telegram getMe failed: HTTP ${me.status}`);
    this.state.detail = 'long polling';
    this.poll((signal) => this.pollOnce(signal));
  }

  /** Fetch one batch of updates (exposed for tests). */
  async pollOnce(signal?: AbortSignal): Promise<void> {
    const res = await this.deps.transport.request(`${this.api}/getUpdates?timeout=25&offset=${this.offset}`, { signal, timeoutMs: 35_000 });
    const data = await res.json<{ ok: boolean; result: TgUpdate[] }>();
    for (const u of data.result ?? []) {
      this.offset = u.update_id + 1;
      if (u.message) await this.handle(u.message);
    }
  }

  private async handle(m: TgMessage): Promise<void> {
    const attachments: InboundAttachment[] = [];
    const file = m.voice ?? m.audio ?? m.document ?? m.photo?.at(-1);
    if (file) {
      const data = await this.download(file.file_id).catch(() => undefined);
      const voice = Boolean(m.voice);
      attachments.push({ name: file.file_name ?? (voice ? 'voice.ogg' : m.photo ? 'photo.jpg' : 'file'), mime: file.mime_type ?? (voice ? 'audio/ogg' : m.photo ? 'image/jpeg' : undefined), data, voice });
    }
    const isGroup = m.chat.type !== 'private';
    await this.receive({
      userId: String(m.from?.id ?? m.chat.id),
      chatId: String(m.chat.id),
      text: m.text ?? m.caption ?? '',
      displayName: m.from?.username ?? m.from?.first_name,
      messageId: String(m.message_id),
      attachments,
      isGroup,
      mentioned: !isGroup || (m.entities ?? []).some((e) => e.type === 'mention'),
    });
  }

  private async download(fileId: string): Promise<Buffer> {
    const info = await (await this.deps.transport.request(`${this.api}/getFile?file_id=${encodeURIComponent(fileId)}`)).json<{ result: { file_path: string } }>();
    const base = (this.opt('apiBase') ?? 'https://api.telegram.org') + `/file/bot${this.need('token', 'TELEGRAM_BOT_TOKEN')}`;
    return (await this.deps.transport.request(`${base}/${info.result.file_path}`)).buffer();
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const text of chunkText(out.text, 4096)) {
      await this.deps.transport.request(`${this.api}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: out.chatId, text, reply_to_message_id: out.replyTo ? Number(out.replyTo) : undefined }),
      });
    }
  }
}
