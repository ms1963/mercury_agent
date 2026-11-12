/**
 * Interactive chat REPL. Every line goes through the CommandProcessor, so slash
 * commands (/new /reset /model /retry /undo /stop /compress /usage /insights
 * /skills /rollback /help, and /<skill>) behave exactly like in the web UI.
 * Risky tool calls prompt for approval in the terminal.
 */
import { createInterface } from 'node:readline/promises';
import type { Principal } from '@mercury/core';
import type { Mercury } from '@mercury/runtime';

const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
};

export interface ChatOptions {
  model?: string;
  sessionId?: string;
  pattern?: string;
  personality?: string;
}

/** One turn with streaming output. Returns the session id. */
export async function chatOnce(m: Mercury, principal: Principal, input: string, opts: ChatOptions, signal?: AbortSignal): Promise<string> {
  let streamed = false;
  const off = m.bus.on('tool.call', (e) => {
    if (e.userId === principal.userId || !e.userId) process.stderr.write(c.dim(`  ⚙ ${String(e.data.name)}\n`));
  });
  try {
    const r = await m.commands.handle({
      principal, input, platform: 'cli', signal, ...opts,
      onDelta: (t: string) => {
        streamed = true;
        process.stdout.write(t);
      },
    });
    if (!streamed || r.command) process.stdout.write(r.output);
    process.stdout.write('\n');
    if (r.run) process.stderr.write(c.dim(`  [${r.run.model ?? ''} · ${r.run.pattern} · ${r.run.usage.inputTokens + r.run.usage.outputTokens} tokens]\n`));
    return r.sessionId;
  } finally {
    off();
  }
}

export async function repl(m: Mercury, principal: Principal, opts: ChatOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  m.approvals.setHandler('cli', async (req) => {
    const ans = await rl.question(c.yellow(`\n⚠ ${req.title} [${req.risk}]\n  ${req.detail.slice(0, 400)}\n  [y/N] `));
    return /^y(es)?$/i.test(ans.trim());
  });
  console.log(c.cyan('Mercury') + c.dim(' — type a message, /help for commands, Ctrl+D to exit.'));
  let sessionId = opts.sessionId;
  let current: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (current) current.abort();
    else rl.close();
  });
  for (;;) {
    let line: string;
    try {
      line = await rl.question(c.cyan('› '));
    } catch {
      break; // stdin closed
    }
    if (!line.trim()) continue;
    if (['/exit', '/quit'].includes(line.trim())) break;
    current = new AbortController();
    try {
      sessionId = await chatOnce(m, principal, line, { ...opts, sessionId }, current.signal);
    } catch (err) {
      console.error(c.yellow(`Error: ${(err as Error).message}`));
    }
    current = undefined;
  }
  rl.close();
}
