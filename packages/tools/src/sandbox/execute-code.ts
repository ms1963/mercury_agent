/**
 * execute_code sandbox (Hermes "programmatic tool calling").
 * The model writes a Python or JavaScript script; the script runs in a child process
 * in a temp directory and can call Mercury tools via `call_tool(name, **args)` (Python)
 * or `await callTool(name, args)` (JS). Calls travel as JSON lines over an extra
 * socketpair on fd 3 and are executed through the normal ToolExecutor pipeline
 * (policy, approvals, audit), so the script never gets more power than the agent.
 * Isolation is process-level (timeout, temp cwd, scrubbed env) — use the docker
 * terminal backend for stronger isolation.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import { errorMessage, newId, type ToolContext } from '@mercury/core';

/** Tools a script may not call (no recursion, no spawning agents from scripts). */
export const SANDBOX_BLOCKED_TOOLS = new Set(['execute_code', 'delegate_task', 'run_workflow', 'schedule_create', 'send_message']);

const PY_PRELUDE = `import json as _json, socket as _socket, sys as _sys
_sock = _socket.socket(fileno=3)
_io = _sock.makefile('rwb')
_n = 0
def call_tool(name, **args):
    """Call a Mercury tool; returns its text output (raises on error)."""
    global _n
    _n += 1
    _io.write((_json.dumps({"id": _n, "tool": name, "args": args}) + "\\n").encode()); _io.flush()
    resp = _json.loads(_io.readline())
    if resp.get("error"): raise RuntimeError(resp["error"])
    return resp["result"]
`;

const JS_PRELUDE = `import net from 'node:net';
import readline from 'node:readline';
const __sock = new net.Socket({ fd: 3, readable: true, writable: true });
const __pending = new Map(); let __n = 0;
readline.createInterface({ input: __sock }).on('line', (l) => { const r = JSON.parse(l); const p = __pending.get(r.id); __pending.delete(r.id); if (!__pending.size) __sock.unref(); r.error ? p.reject(new Error(r.error)) : p.resolve(r.result); });
__sock.unref();
/** Call a Mercury tool; resolves to its text output. */
globalThis.callTool = (name, args = {}) => new Promise((resolve, reject) => { const id = ++__n; __pending.set(id, { resolve, reject }); __sock.ref(); __sock.write(JSON.stringify({ id, tool: name, args }) + '\\n'); });
`;

export interface ExecuteCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  toolCalls: number;
  timedOut: boolean;
}

export async function executeCode(ctx: ToolContext, language: 'python' | 'javascript', code: string): Promise<ExecuteCodeResult> {
  const cfg = ctx.services.config.tools.executeCode;
  const dir = mkdtempSync(join(tmpdir(), 'mercury-code-'));
  const file = join(dir, language === 'python' ? 'main.py' : 'main.mjs');
  writeFileSync(file, (language === 'python' ? PY_PRELUDE : JS_PRELUDE) + '\n' + code + '\n');
  const argv = language === 'python' ? ['python3', '-u', file] : [process.execPath, file];

  // Scrubbed environment: no API keys or secrets leak into model-written code.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' };
  // Own process group (POSIX): timeout/abort kills any processes the code spawned, too.
  const group = process.platform !== 'win32';
  const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: group });
  const killTree = () => {
    try {
      if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const rpc = child.stdio[3] as Socket;
  let stdout = '';
  let stderr = '';
  let toolCalls = 0;
  let timedOut = false;
  child.stdout!.on('data', (d: Buffer) => (stdout = (stdout + d).slice(-100_000)));
  child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d).slice(-50_000)));

  // Write a JSON-RPC response back to the sandboxed child. The child may have exited
  // (or been killed on timeout) and closed its end of the pipe between making a call and
  // our async reply, so a write here can fail with EPIPE/ERR_STREAM_DESTROYED. Treat a
  // closed pipe as a no-op: there is no longer anyone to deliver the response to.
  const replyToChild = (payload: unknown): void => {
    if (rpc.destroyed || !rpc.writable) return;
    try {
      rpc.write(JSON.stringify(payload) + '\n', () => undefined);
    } catch {
      /* pipe already closed — nothing to deliver */
    }
  };

  const rl = createInterface({ input: rpc });
  rl.on('line', (line) => {
    void (async () => {
      let id: unknown;
      try {
        const req = JSON.parse(line) as { id: number; tool: string; args?: Record<string, unknown> };
        id = req.id;
        if (++toolCalls > cfg.maxToolCalls) throw new Error(`tool call limit (${cfg.maxToolCalls}) reached`);
        if (SANDBOX_BLOCKED_TOOLS.has(req.tool)) throw new Error(`tool ${req.tool} cannot be called from execute_code`);
        const executor = ctx.services.executor;
        if (!executor) throw new Error('tool executor unavailable');
        const res = await executor.execute(
          { id: newId('call'), name: req.tool, arguments: req.args ?? {} },
          ctx,
          { untrustedSeen: true, userRequest: '' },
        );
        replyToChild(res.ok ? { id, result: res.result.content } : { id, error: res.result.content });
      } catch (err) {
        replyToChild({ id, error: errorMessage(err) });
      }
    })();
  });
  // The readline Interface re-emits its input stream's 'error' on itself; without this
  // handler an EPIPE on the fd-3 socket would escalate to a fatal unhandled 'error' event
  // and crash the whole server process.
  rl.on('error', () => undefined);
  rpc.on('error', () => undefined);

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, cfg.timeoutMs);
    const onAbort = () => killTree();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
    child.on('error', (err) => {
      stderr += String(err);
    });
  });
  rpc.destroy();
  rmSync(dir, { recursive: true, force: true });
  return { stdout, stderr, exitCode, toolCalls, timedOut };
}
