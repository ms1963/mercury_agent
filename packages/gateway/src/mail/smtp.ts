/**
 * Minimal SMTP client (RFC 5321) over node:net / node:tls: EHLO, optional
 * STARTTLS, AUTH PLAIN, MAIL FROM, RCPT TO, DATA. Enough for sending plain-text
 * replies without an external dependency.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (port 465). */
  secure?: boolean;
  /** Upgrade with STARTTLS when offered (default true). */
  starttls?: boolean;
  user?: string;
  pass?: string;
  timeoutMs?: number;
  /** Accept self-signed certificates (testing only). */
  insecure?: boolean;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}

/** Build an RFC 5322 message with dot-stuffing applied. */
export function buildMessage(m: MailMessage, date = new Date()): string {
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject.replace(/[\r\n]/g, ' ')}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@mercury>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
  ];
  const body = m.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** Line-oriented reader that resolves complete (possibly multi-line) SMTP replies. */
class Replies {
  private buf = '';
  private waiters: Array<(r: { code: number; text: string }) => void> = [];
  private ready: Array<{ code: number; text: string }> = [];
  private lines: string[] = [];

  feed(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.lines.push(line);
      if (line[3] !== '-') {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w(reply);
        else this.ready.push(reply);
      }
    }
  }

  next(): Promise<{ code: number; text: string }> {
    const r = this.ready.shift();
    return r ? Promise.resolve(r) : new Promise((res) => this.waiters.push(res));
  }
}

export async function sendMail(opts: SmtpOptions, msg: MailMessage): Promise<void> {
  let socket: net.Socket = opts.secure
    ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: !opts.insecure })
    : net.connect({ host: opts.host, port: opts.port });
  socket.setTimeout(opts.timeoutMs ?? 30_000, () => socket.destroy(new Error('SMTP timeout')));
  let replies = new Replies();
  const attach = (s: net.Socket) => s.on('data', (d: Buffer) => replies.feed(d.toString('utf8')));
  attach(socket);
  const failed = new Promise<never>((_, rej) => socket.once('error', rej));

  const expect = async (ok: number[]) => {
    const r = await Promise.race([replies.next(), failed]);
    if (!ok.includes(r.code)) throw new Error(`SMTP error ${r.code}: ${r.text}`);
    return r;
  };
  const cmd = async (line: string, ok: number[]) => {
    socket.write(line + '\r\n');
    return expect(ok);
  };

  try {
    await expect([220]);
    let ehlo = await cmd('EHLO mercury', [250]);
    if (!opts.secure && opts.starttls !== false && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket = tls.connect({ socket, servername: opts.host, rejectUnauthorized: !opts.insecure });
      replies = new Replies();
      attach(socket);
      await new Promise((r) => socket.once('secureConnect', r));
      ehlo = await cmd('EHLO mercury', [250]);
    }
    if (opts.user) {
      const token = Buffer.from(`\0${opts.user}\0${opts.pass ?? ''}`).toString('base64');
      await cmd(`AUTH PLAIN ${token}`, [235]);
    }
    const addr = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s.trim();
    await cmd(`MAIL FROM:<${addr(msg.from)}>`, [250]);
    await cmd(`RCPT TO:<${addr(msg.to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    await cmd(`${buildMessage(msg)}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => undefined);
  } finally {
    socket.end();
  }
}
