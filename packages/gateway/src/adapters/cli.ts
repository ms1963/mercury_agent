/**
 * CLI adapter: treats a pair of streams (default stdin/stdout) as a chat
 * channel, so `mercury gateway` can be tried locally without any platform.
 * Config: userId (default "local"), prompt.
 */
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { BaseAdapter } from '../base.js';
import type { AdapterDeps, OutboundMessage } from '../types.js';

export class CliAdapter extends BaseAdapter {
  readonly type = 'cli';
  private rl?: Interface;

  constructor(name: string, config: Record<string, unknown>, deps: AdapterDeps, private input: Readable = process.stdin, private output: Writable = process.stdout) {
    super(name, config, deps);
  }

  protected override async connect(): Promise<void> {
    this.rl = createInterface({ input: this.input, terminal: false });
    const user = this.opt('userId') ?? 'local';
    this.rl.on('line', (line) => {
      if (line.trim()) void this.receive({ userId: user, chatId: user, text: line });
    });
    this.state.detail = 'stdin/stdout';
  }

  protected override async disconnect(): Promise<void> {
    this.rl?.close();
  }

  async send(out: OutboundMessage): Promise<void> {
    this.output.write(`${out.text}\n`);
  }
}
