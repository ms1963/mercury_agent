/**
 * Minimal IMAP4rev1 client: LOGIN, SELECT, SEARCH UNSEEN, FETCH BODY.PEEK[],
 * STORE \Seen, LOGOUT. Handles literals ({n}) in responses. Designed for polling
 * an inbox, not as a general mail library.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface ImapOptions {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
  mailbox?: string;
  insecure?: boolean;
  timeoutMs?: number;
}

export class ImapSession {
  private socket!: net.Socket;
  private buf = Buffer.alloc(0);
  private tag = 0;
  private pending?: { tag: string; resolve: (lines: string) => void; reject: (e: Error) => void };

  constructor(private opts: ImapOptions) {}

  async open(): Promise<void> {
    const { host, port, secure, insecure } = this.opts;
    this.socket = secure ? tls.connect({ host, port, rejectUnauthorized: !insecure }) : net.connect({ host, port });
    this.socket.setTimeout(this.opts.timeoutMs ?? 30_000, () => this.socket.destroy(new Error('IMAP timeout')));
    this.socket.on('error', (e) => this.pending?.reject(e));
    const greeting = new Promise<void>((resolve) => this.socket.once('data', () => resolve()));
    this.socket.on('data', (d: Buffer) => this.onData(d));
    await greeting;
    await this.command(`LOGIN ${quote(this.opts.user)} ${quote(this.opts.pass)}`);
    await this.command(`SELECT ${quote(this.opts.mailbox ?? 'INBOX')}`);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    const p = this.pending;
    if (!p) return;
    const text = this.buf.toString('utf8');
    const m = new RegExp(`(^|\\r\\n)${p.tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`).exec(text);
    if (!m) return;
    this.buf = Buffer.alloc(0);
    this.pending = undefined;
    if (m[2] === 'OK') p.resolve(text.slice(0, m.index));
    else p.reject(new Error(`IMAP ${m[2]}:${m[3]}`));
  }

  /** Send a tagged command and resolve with the untagged response text. */
  command(cmd: string): Promise<string> {
    const tag = `A${++this.tag}`;
    return new Promise((resolve, reject) => {
      this.pending = { tag, resolve, reject };
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }

  async searchUnseen(): Promise<number[]> {
    const res = await this.command('SEARCH UNSEEN');
    const line = res.split('\r\n').find((l) => l.startsWith('* SEARCH'));
    return line ? line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  /** Fetch the raw RFC 822 message without marking it read. */
  async fetchRaw(seq: number): Promise<string> {
    const res = await this.command(`FETCH ${seq} BODY.PEEK[]`);
    const m = /\{(\d+)\}\r\n/.exec(res);
    if (!m) return '';
    const start = m.index + m[0].length;
    return Buffer.from(res.slice(start), 'utf8').subarray(0, Number(m[1])).toString('utf8');
  }

  async markSeen(seq: number): Promise<void> {
    await this.command(`STORE ${seq} +FLAGS (\\Seen)`);
  }

  async close(): Promise<void> {
    await this.command('LOGOUT').catch(() => undefined);
    this.socket.end();
  }
}

function quote(s: string): string {
  return `"${s.replace(/["\\]/g, (c) => '\\' + c)}"`;
}

export interface ParsedMail {
  from: string;
  fromAddress: string;
  subject: string;
  messageId?: string;
  text: string;
}

/** Parse headers and extract a text/plain body (handles simple multipart, QP, base64). */
export function parseMail(raw: string): ParsedMail {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = parseHeaders(head ?? '');
  let body = rest.join('\n\n');
  const ctype = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  let encoding = headers['content-transfer-encoding'];
  if (boundary) {
    const parts = body.split(`--${boundary}`).slice(1);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) ?? parts[0] ?? '';
    const [ph, ...pb] = plain.split(/\r?\n\r?\n/);
    encoding = parseHeaders(ph ?? '')['content-transfer-encoding'];
    body = pb.join('\n\n');
  }
  const from = headers['from'] ?? '';
  return {
    from,
    fromAddress: (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase(),
    subject: headers['subject'] ?? '',
    messageId: headers['message-id'],
    text: decodeBody(body, encoding).replace(/\r\n/g, '\n').trim(),
  };
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function decodeBody(body: string, encoding?: string): string {
  const enc = (encoding ?? '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}
