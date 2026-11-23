/**
 * execute_code sandbox (Hermes "programmatic tool calling").
 * The model writes a Python or JavaScript script; the script runs in a child process
 * in a temp directory and can call Mercury tools via `call_tool(name, **args)` (Python)
 * or `await callTool(name, args)` (JS). Calls travel as JSON lines over an extra
 * socketpair on fd 3 and are executed through the normal ToolExecutor pipeline
 * (policy, approvals, audit), so the script never gets more power than the agent.
 * Backends (`tools.executeCode.backend`):
 *  - host:   child process (timeout, temp cwd, scrubbed env, own process group). Not a sandbox.
 *  - docker: container with no network, all capabilities dropped, read-only root and code
 *            mount, nobody user, pid/memory/CPU limits. Tool calls use stdin/stderr framing.
 *  - auto:   docker when `tools.terminal.backend` is docker, otherwise host.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { errorMessage, newId, type MercuryConfig, type ToolContext } from '@mercury/core';
import { safeEnv } from '../terminal/backends.js';

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

/** Stdio framing (docker): requests are stderr lines with this prefix, responses arrive on stdin. */
export const RPC_MARKER = '\u001eMRPC ';

const PY_PRELUDE_STDIO = `import json as _json, sys as _sys
_n = 0
def call_tool(name, **args):
    """Call a Mercury tool; returns its text output (raises on error)."""
    global _n
    _n += 1
    _sys.stderr.write("\\u001eMRPC " + _json.dumps({"id": _n, "tool": name, "args": args}) + "\\n"); _sys.stderr.flush()
    line = _sys.stdin.readline()
    if not line: raise RuntimeError("tool channel closed")
    resp = _json.loads(line)
    if resp.get("error"): raise RuntimeError(resp["error"])
    return resp["result"]
`;

const JS_PRELUDE_STDIO = `import readline from 'node:readline';
const __pending = new Map(); let __n = 0; let __rl = null;
// stdin is only referenced while a call is pending, so a script with no outstanding calls exits.
function __ensure() {
  process.stdin.ref?.();
  if (__rl) return;
  __rl = readline.createInterface({ input: process.stdin });
  __rl.on('line', (l) => { const r = JSON.parse(l); const p = __pending.get(r.id); __pending.delete(r.id); if (!__pending.size) process.stdin.unref?.(); r.error ? p.reject(new Error(r.error)) : p.resolve(r.result); });
}
/** Call a Mercury tool; resolves to its text output. */
globalThis.callTool = (name, args = {}) => new Promise((resolve, reject) => { const id = ++__n; __pending.set(id, { resolve, reject }); __ensure(); process.stderr.write('\\u001eMRPC ' + JSON.stringify({ id, tool: name, args }) + '\\n'); });
`;

export type ExecuteCodeBackend = 'host' | 'docker';

/** Resolve the configured backend ('auto' follows the terminal backend). */
export function resolveExecuteCodeBackend(config: MercuryConfig): ExecuteCodeBackend {
  const b = config.tools.executeCode.backend ?? 'auto';
  if (b === 'auto') return config.tools.terminal.backend === 'docker' ? 'docker' : 'host';
  return b;
}

/** docker run argv for a script in `dir` (mounted read-only at /code). */
export function dockerCodeArgv(config: MercuryConfig, language: 'python' | 'javascript', dir: string, name: string): string[] {
  const c = config.tools.executeCode;
  const image = language === 'python' ? c.pythonImage : c.nodeImage;
  const run = language === 'python' ? ['python3', '-u', '/code/main.py'] : ['node', '/code/main.mjs'];
  return [
    'docker', 'run', '--rm', '-i', '--init', '--name', name,
    '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '512m', '--cpus', '1',
    '--user', '65534:65534', '-e', 'HOME=/tmp', '-e', 'LANG=C.UTF-8', '-v', `${dir}:/code:ro`, '-w', '/tmp',
    image, ...run,
  ];
}

const DOCKER_CLI_ENV = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];

export interface ExecuteCodeOptions {
  /** Override the configured backend (tests). */
  backend?: ExecuteCodeBackend;
  /** Force the stdio tool-call framing on the host backend (tests the docker protocol without docker). */
  transport?: 'fd3' | 'stdio';
}

export interface ExecuteCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  toolCalls: number;
  timedOut: boolean;
}

export async function executeCode(ctx: ToolContext, language: 'python' | 'javascript', code: string, opts: ExecuteCodeOptions = {}): Promise<ExecuteCodeResult> {
  const config = ctx.services.config;
  const cfg = config.tools.executeCode;
  const backend = opts.backend ?? resolveExecuteCodeBackend(config);
  const stdioRpc = backend === 'docker' || opts.transport === 'stdio';
  const dir = mkdtempSync(join(tmpdir(), 'mercury-code-'));
  const file = join(dir, language === 'python' ? 'main.py' : 'main.mjs');
  const prelude = language === 'python' ? (stdioRpc ? PY_PRELUDE_STDIO : PY_PRELUDE) : stdioRpc ? JS_PRELUDE_STDIO : JS_PRELUDE;
  writeFileSync(file, prelude + '\n' + code + '\n');
  // mkdtemp is 0700; the container runs as nobody and must be able to read the mounted script.
  if (backend === 'docker') {
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
  }
  const container = `mercury-code-${randomBytes(6).toString('hex')}`;
  const argv =
    backend === 'docker' ? dockerCodeArgv(config, language, dir, container) : language === 'python' ? ['python3', '-u', file] : [process.execPath, file];

  // Scrubbed environment: no API keys or secrets leak into model-written code. The docker CLI
  // only gets what it needs to reach the daemon; the container gets HOME/LANG via -e.
  const env: Record<string, string> =
    backend === 'docker'
      ? { ...safeEnv(), ...Object.fromEntries(DOCKER_CLI_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])) }
      : { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' };
  // Own process group (POSIX): timeout/abort kills any processes the code spawned, too.
  const group = process.platform !== 'win32';
  const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env, stdio: stdioRpc ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'], detached: group });
  const killTree = () => {
    try {
      if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    // Killing the docker CLI does not stop the container: remove it explicitly.
    if (backend === 'docker') spawn('docker', ['rm', '-f', container], { stdio: 'ignore', env }).on('error', () => undefined).unref();
  };
  let stdout = '';
  let stderr = '';
  let toolCalls = 0;
  let timedOut = false;
  child.stdout!.on('data', (d: Buffer) => (stdout = (stdout + d).slice(-100_000)));
  // Responses go to fd 3 (host) or stdin (stdio framing); requests come from fd 3 or framed stderr lines.
  const rpc = (stdioRpc ? child.stdin! : child.stdio[3]) as Socket;
  let requests: NodeJS.ReadableStream = rpc;
  if (stdioRpc) {
    const framed = new PassThrough();
    const errLines = createInterface({ input: child.stderr! });
    errLines.on('line', (l) => {
      if (l.startsWith(RPC_MARKER)) framed.write(l.slice(RPC_MARKER.length) + '\n');
      else stderr = (stderr + l + '\n').slice(-50_000);
    });
    errLines.on('close', () => framed.end());
    requests = framed;
  } else {
    child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d).slice(-50_000)));
  }

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

  const rl = createInterface({ input: requests });
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
