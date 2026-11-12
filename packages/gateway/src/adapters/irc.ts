/**
 * IRC adapter over a raw TCP/TLS socket (RFC 1459 subset): NICK/USER, JOIN,
 * PING/PONG, PRIVMSG. Channel messages are answered only when the bot's nick is
 * mentioned; private messages always.
 * Config: host, port (6697), tls (true), nick, channels (array), password.
 */
import net from 'node:net';
import tls from 'node:tls';
import { BaseAdapter, chunkText } from '../base.js';
import type { OutboundMessage } from '../types.js';

/** Parse one IRC line into prefix nick, command, params and trailing text. */
export function parseIrcLine(line: string): { nick?: string; command: string; params: string[]; trailing?: string } {
  let rest = line;
  let nick: string | undefined;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    nick = rest.slice(1, sp).split('!')[0];
    rest = rest.slice(sp + 1);
  }
  const ti = rest.indexOf(' :');
  const trailing = ti >= 0 ? rest.slice(ti + 2) : undefined;
  const [command = '', ...params] = (ti >= 0 ? rest.slice(0, ti) : rest).split(' ').filter(Boolean);
  return { nick, command, params, trailing };
}

export class IrcAdapter extends BaseAdapter {
  readonly type = 'irc';
  private socket?: net.Socket;
  private buffer = '';

  private get nick(): string {
    return this.opt('nick') ?? 'mercury';
  }

  protected override async connect(): Promise<void> {
    const host = this.need('host');
    const port = Number(this.config.port ?? 6697);
    const useTls = this.config.tls !== false;
    this.socket = useTls ? tls.connect({ host, port }) : net.connect({ host, port });
    this.socket.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
    this.socket.on('error', (e) => (this.state.error = e.message));
    this.socket.on('close', () => (this.state.connected = false));
    const pass = this.opt('password');
    if (pass) this.write(`PASS ${pass}`);
    this.write(`NICK ${this.nick}`);
    this.write(`USER ${this.nick} 0 * :Mercury agent`);
    this.state.detail = `${host}:${port}`;
  }

  protected override async disconnect(): Promise<void> {
    this.write('QUIT :bye');
    this.socket?.end();
  }

  private write(line: string): void {
    this.socket?.write(line.replace(/[\r\n]/g, ' ') + '\r\n');
  }

  /** Process incoming data (public for tests). */
  onData(chunk: string): void {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\r\n')) >= 0) {
      const msg = parseIrcLine(this.buffer.slice(0, i));
      this.buffer = this.buffer.slice(i + 2);
      if (msg.command === 'PING') this.write(`PONG :${msg.trailing ?? ''}`);
      else if (msg.command === '001') for (const ch of (this.config.channels as string[] | undefined) ?? []) this.write(`JOIN ${ch}`);
      else if (msg.command === 'PRIVMSG' && msg.nick && msg.trailing !== undefined) {
        const target = msg.params[0] ?? '';
        const isGroup = target.startsWith('#');
        const mentioned = !isGroup || msg.trailing.toLowerCase().includes(this.nick.toLowerCase());
        const text = msg.trailing.replace(new RegExp(`^${this.nick}[:,]?\\s*`, 'i'), '');
        void this.receive({ userId: msg.nick, chatId: isGroup ? target : msg.nick, text, displayName: msg.nick, isGroup, mentioned });
      }
    }
  }

  async send(out: OutboundMessage): Promise<void> {
    for (const line of out.text.split('\n').flatMap((l) => chunkText(l, 400)).filter(Boolean)) this.write(`PRIVMSG ${out.chatId} :${line}`);
  }
}
