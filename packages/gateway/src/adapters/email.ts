/**
 * Email adapter: polls an IMAP inbox for unseen mail and replies via SMTP.
 * The sender address is the user id and chat id; replies keep the subject thread.
 * Config: imapHost, imapPort (993), imapSecure (true), smtpHost, smtpPort (587),
 * smtpSecure (false), user (EMAIL_USER), pass (EMAIL_PASSWORD), from, intervalMs.
 */
import { BaseAdapter } from '../base.js';
import type { OutboundMessage } from '../types.js';
import { ImapSession, parseMail } from '../mail/imap.js';
import { sendMail } from '../mail/smtp.js';

export class EmailAdapter extends BaseAdapter {
  readonly type = 'email';
  /** Last subject / message id per correspondent, used for threading replies. */
  private threads = new Map<string, { subject: string; messageId?: string }>();

  private num(key: string, def: number): number {
    return Number(this.config[key] ?? def);
  }
  private flag(key: string, def: boolean): boolean {
    return this.config[key] === undefined ? def : Boolean(this.config[key]);
  }

  protected override async connect(): Promise<void> {
    this.need('user', 'EMAIL_USER');
    if (this.opt('imapHost')) {
      this.state.detail = `IMAP polling ${this.opt('imapHost')}`;
      this.poll(() => this.pollOnce(), this.num('intervalMs', 60_000));
    } else this.state.detail = 'send-only (no imapHost configured)';
  }

  async pollOnce(): Promise<void> {
    const session = new ImapSession({
      host: this.need('imapHost'),
      port: this.num('imapPort', 993),
      secure: this.flag('imapSecure', true),
      user: this.need('user', 'EMAIL_USER'),
      pass: this.need('pass', 'EMAIL_PASSWORD'),
      insecure: this.flag('insecure', false),
    });
    await session.open();
    try {
      for (const seq of await session.searchUnseen()) {
        const mail = parseMail(await session.fetchRaw(seq));
        await session.markSeen(seq);
        if (!mail.fromAddress) continue;
        this.threads.set(mail.fromAddress, { subject: mail.subject, messageId: mail.messageId });
        await this.receive({ userId: mail.fromAddress, chatId: mail.fromAddress, text: mail.text, subject: mail.subject, displayName: mail.from, messageId: mail.messageId });
      }
    } finally {
      await session.close();
    }
  }

  async send(out: OutboundMessage): Promise<void> {
    const thread = this.threads.get(out.chatId.toLowerCase());
    const subject = out.subject ?? (thread ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : 'Message from Mercury');
    await sendMail(
      {
        host: this.need('smtpHost'),
        port: this.num('smtpPort', 587),
        secure: this.flag('smtpSecure', false),
        user: this.opt('user', 'EMAIL_USER'),
        pass: this.opt('pass', 'EMAIL_PASSWORD'),
        insecure: this.flag('insecure', false),
      },
      { from: this.opt('from') ?? this.need('user', 'EMAIL_USER'), to: out.chatId, subject, text: out.text, inReplyTo: out.replyTo ?? thread?.messageId },
    );
  }
}
