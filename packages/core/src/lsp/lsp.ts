/**
 * Mercury as a **Language Server Protocol (LSP) server** (Tier-4 gap #17).
 *
 * The {@link https://microsoft.github.io/language-server-protocol/ | Language Server Protocol} (LSP) is a
 * JSON-RPC 2.0 standard that lets LSP *clients* (editors / IDEs such as VS Code, Neovim, Zed) drive a
 * *language server*. Where the ACP server (`packages/core/src/acp`) exposes Mercury to ACP clients and
 * the MCP server (`packages/mcp`) exposes Mercury's tools to MCP clients, the LSP server exposes the
 * SAME underlying agent + tool surface over the LSP wire so any LSP-capable editor can reach Mercury
 * through its built-in language-server plumbing.
 *
 * ## Wire format
 * LSP speaks JSON-RPC 2.0 over a bidirectional stream, but — unlike ACP's newline-delimited framing —
 * each message is wrapped in an HTTP-style header block:
 *
 * ```
 * Content-Length: 123\r\n
 * \r\n
 * {"jsonrpc":"2.0", ... }
 * ```
 *
 * `Content-Length` counts the UTF-8 **bytes** of the JSON body. The framing read/write is implemented
 * here as PURE functions ({@link encodeLspMessage} / {@link decodeLspFrames}) so partial buffers and
 * multiple messages in one chunk are handled and unit-testable without any real stdio.
 *
 * ## Lifecycle & methods
 *   - `initialize`                 — capability negotiation; replies with `serverInfo` + `capabilities`.
 *   - `initialized`                — client ack notification (no response).
 *   - `shutdown`                   — request a clean shutdown (replies with `null`).
 *   - `exit`                       — notification; the transport ends the serve loop.
 *   - `textDocument/didOpen`       — track an opened document (uri → version + text).
 *   - `textDocument/didChange`     — apply a full-text change to a tracked document.
 *   - `textDocument/didClose`      — stop tracking a document.
 *   - `workspace/executeCommand`   — run a Mercury command: `mercury.prompt` (run an agent turn),
 *                                    `mercury.tools.list`, `mercury.tools.call`.
 *
 * Plus underscore-prefixed **vendor extensions** mirroring the ACP server so a client can reach the
 * agent/tool surface directly:
 *   - `_mercury/agent/prompt`      — run one agent prompt turn.
 *   - `_mercury/tools/list`        — list Mercury tool specs.
 *   - `_mercury/tools/call`        — invoke one Mercury tool by name.
 *
 * While an agent turn runs, streamed output is pushed to the client as `$/progress` notifications.
 *
 * ## Design (house style)
 * Split into **pure** framing + request-dispatch functions (no fs/network — fully unit-testable with an
 * injected {@link LspAgent} stub and an injected `emit` sink) plus a thin stdio transport
 * ({@link serveLspStdio}) that does the Content-Length framing over real streams.
 *
 * ## Honesty
 * The framing, every method handler and the error paths are exercised offline and deterministically by
 * `tests/lsp.test.ts` against injected stubs and in-memory streams. The runtime adapter
 * `m.lspAgent(principal)` binds a real Mercury agent and returns its final output. The server has **not**
 * been exercised against a real external LSP client (e.g. VS Code / Zed) — only against the
 * deterministic offline tests.
 */
import type { Readable, Writable } from 'node:stream';
import { errorMessage } from '../types/common.js';
import type { AcpAgent, AcpPromptOptions, AcpSessionUpdate } from '../acp/acp.js';

/** The LSP specification version this server targets. */
export const LSP_PROTOCOL = '3.17';

/** `workspace/executeCommand` commands this server advertises + handles. */
export const LSP_COMMANDS = ['mercury.prompt', 'mercury.tools.list', 'mercury.tools.call'] as const;

/** JSON-RPC 2.0 standard error codes plus the LSP-reserved ones used here. */
export const LSP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // LSP-specific (JSON-RPC reserved range):
  serverNotInitialized: -32002,
  requestFailed: -32803,
} as const;

/** A JSON-RPC id (string or integer; never null for a request). */
export type LspId = string | number;

/**
 * What the LSP server needs from Mercury — the SAME shape as the ACP server's {@link AcpAgent} (agent
 * run + tool surface). Reusing the type lets the runtime bind one adapter for both protocols.
 */
export type LspAgent = AcpAgent;
/** Re-exported for callers that only import from the LSP module. */
export type LspPromptOptions = AcpPromptOptions;
/** A streamed update pushed to the client during an agent turn. */
export type LspUpdate = AcpSessionUpdate;

/** A parsed JSON-RPC request or notification (no `id` ⇒ notification). */
export interface LspRequest {
  jsonrpc: '2.0';
  id?: LspId;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC response (success xor error). */
export interface LspResponse {
  jsonrpc: '2.0';
  id: LspId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One tracked text document (full-sync). */
export interface LspDocument {
  uri: string;
  languageId?: string;
  version: number;
  text: string;
}

/** Server state threaded through the pure dispatch (no globals). */
export interface LspServerState {
  initialized: boolean;
  /** Set once `shutdown` has been requested; a further request (other than `exit`) is invalid. */
  shutdownRequested: boolean;
  /** Reported in `serverInfo.version` of the `initialize` result. */
  version: string;
  /** Open documents keyed by uri. */
  documents: Map<string, LspDocument>;
}

/** Create a fresh server state. Pass the real CLI version so `serverInfo.version` is honest. */
export function createLspState(opts: { version?: string } = {}): LspServerState {
  return {
    initialized: false,
    shutdownRequested: false,
    version: opts.version ?? '0.0.0',
    documents: new Map(),
  };
}

/** A notification sink: the transport serializes and writes these to the client. */
export type LspEmit = (method: string, params: Record<string, unknown>) => void;

// ── pure framing (Content-Length) ────────────────────────────────────────────

/** Frame a JSON-RPC message with an LSP `Content-Length` header. Pure. */
export function encodeLspMessage(obj: unknown): string {
  const body = JSON.stringify(obj);
  const len = Buffer.byteLength(body, 'utf8');
  return `Content-Length: ${len}\r\n\r\n${body}`;
}

/**
 * Extract complete LSP frames from a byte buffer. Returns the decoded JSON bodies plus the unconsumed
 * remainder (a partial frame waiting for more bytes). Pure — no IO.
 *
 * - Handles **multiple** messages in one chunk and a message **split across** chunks (partial buffer).
 * - A header block that has the `\r\n\r\n` separator but no valid `Content-Length` is a malformed frame:
 *   it is skipped (consumed) rather than throwing, so the stream can recover.
 */
export function decodeLspFrames(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n', offset, 'utf8');
    if (sep < 0) break; // no complete header yet
    const header = buf.toString('utf8', offset, sep);
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Malformed header (no Content-Length): drop it and resync past the separator.
      offset = sep + 4;
      continue;
    }
    const len = Number(match[1]);
    const bodyStart = sep + 4;
    const bodyEnd = bodyStart + len;
    if (bodyEnd > buf.length) break; // body not fully arrived yet — keep it in `rest`
    messages.push(buf.toString('utf8', bodyStart, bodyEnd));
    offset = bodyEnd;
  }
  return { messages, rest: buf.subarray(offset) };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Build a success response. */
export function lspResult(id: LspId | null, result: unknown): LspResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build an error response. */
export function lspError(id: LspId | null, code: number, message: string, data?: unknown): LspResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

function idOf(m: Record<string, unknown>): LspId | null {
  const id = m.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Parse one decoded JSON-RPC body. Returns the parsed request or an {@link LspResponse} error
 * (parse / invalid-request) ready to send back. Pure — no IO.
 */
export function parseLspMessage(body: string): LspRequest | LspResponse {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return lspError(null, LSP_ERROR.parse, 'Parse error: invalid JSON');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return lspError(null, LSP_ERROR.invalidRequest, 'Invalid Request: expected a JSON-RPC object');
  }
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') {
    return lspError(idOf(m), LSP_ERROR.invalidRequest, 'Invalid Request: jsonrpc must be "2.0"');
  }
  if (typeof m.method !== 'string' || m.method.length === 0) {
    return lspError(idOf(m), LSP_ERROR.invalidRequest, 'Invalid Request: missing method');
  }
  const req: LspRequest = { jsonrpc: '2.0', method: m.method };
  if (m.id !== undefined && m.id !== null) req.id = m.id as LspId;
  if (m.params !== undefined) {
    if (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params)) {
      return lspError(idOf(m), LSP_ERROR.invalidParams, 'Invalid params: expected an object or array');
    }
    req.params = m.params as Record<string, unknown>;
  }
  return req;
}

/** A value is a response (already-built error) rather than a request. */
export function isLspResponse(v: LspRequest | LspResponse): v is LspResponse {
  return 'result' in v || 'error' in v;
}

/** Coerce a prompt argument into a plain string (accepts a string or an array of text content blocks). */
export function lspPromptText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : typeof b === 'string' ? b : ''))
      .join('');
  }
  if (v && typeof v === 'object' && typeof (v as { prompt?: unknown }).prompt === 'string') return (v as { prompt: string }).prompt;
  return '';
}

// ── method dispatch ──────────────────────────────────────────────────────────

/**
 * Handle one parsed JSON-RPC message. Pure with respect to IO: all side effects are the returned
 * response and any `emit`ted notifications. Returns `null` for notifications (no response expected).
 */
export async function handleLspMessage(
  state: LspServerState,
  agent: LspAgent,
  req: LspRequest,
  emit: LspEmit,
): Promise<LspResponse | null> {
  const id = req.id ?? null;
  const notification = req.id === undefined;
  const params = req.params ?? {};

  try {
    switch (req.method) {
      case 'initialize': {
        state.initialized = true;
        return respond(id, notification, {
          capabilities: {
            // 1 = full document sync (the whole text is re-sent on each change).
            textDocumentSync: { openClose: true, change: 1 },
            executeCommandProvider: { commands: [...LSP_COMMANDS] },
          },
          serverInfo: { name: 'mercury', version: state.version },
        });
      }

      case 'initialized':
        // Client ack notification — nothing to do.
        return null;

      case 'shutdown': {
        if (!state.initialized) return guardInit(id, notification);
        state.shutdownRequested = true;
        // LSP `shutdown` replies with a null result.
        return respond(id, notification, null);
      }

      case 'exit':
        // Notification handled by the transport (ends the serve loop). No response.
        return null;

      case 'textDocument/didOpen': {
        const doc = params.textDocument as Partial<LspDocument> | undefined;
        if (doc && typeof doc.uri === 'string') {
          state.documents.set(doc.uri, {
            uri: doc.uri,
            languageId: typeof doc.languageId === 'string' ? doc.languageId : undefined,
            version: typeof doc.version === 'number' ? doc.version : 0,
            text: typeof doc.text === 'string' ? doc.text : '',
          });
        }
        return null;
      }

      case 'textDocument/didChange': {
        const doc = params.textDocument as { uri?: unknown; version?: unknown } | undefined;
        const changes = params.contentChanges;
        if (doc && typeof doc.uri === 'string' && Array.isArray(changes) && changes.length) {
          const existing = state.documents.get(doc.uri);
          // Full sync: the last change carries the whole new document text.
          const last = changes[changes.length - 1] as { text?: unknown };
          const text = typeof last?.text === 'string' ? last.text : existing?.text ?? '';
          state.documents.set(doc.uri, {
            uri: doc.uri,
            languageId: existing?.languageId,
            version: typeof doc.version === 'number' ? doc.version : (existing?.version ?? 0) + 1,
            text,
          });
        }
        return null;
      }

      case 'textDocument/didClose': {
        const doc = params.textDocument as { uri?: unknown } | undefined;
        if (doc && typeof doc.uri === 'string') state.documents.delete(doc.uri);
        return null;
      }

      case 'workspace/executeCommand': {
        if (!state.initialized) return guardInit(id, notification);
        return await handleExecuteCommand(agent, id, notification, params, emit);
      }

      case '_mercury/agent/prompt': {
        if (!state.initialized) return guardInit(id, notification);
        return await handlePrompt(agent, id, notification, lspPromptText(params.prompt), emit);
      }

      case '_mercury/tools/list': {
        if (!state.initialized) return guardInit(id, notification);
        return respond(id, notification, { tools: toolList(agent) });
      }

      case '_mercury/tools/call': {
        if (!state.initialized) return guardInit(id, notification);
        return await callTool(agent, id, notification, params);
      }

      default:
        if (notification) return null; // ignore unknown notifications (LSP allows this)
        return respond(id, notification, undefined, lspError(id, LSP_ERROR.methodNotFound, `Method not found: ${req.method}`));
    }
  } catch (err) {
    if (notification) return null;
    return lspError(id, LSP_ERROR.internal, errorMessage(err));
  }
}

async function handleExecuteCommand(
  agent: LspAgent,
  id: LspId | null,
  notification: boolean,
  params: Record<string, unknown>,
  emit: LspEmit,
): Promise<LspResponse | null> {
  const command = typeof params.command === 'string' ? params.command : undefined;
  if (!command) return respond(id, notification, undefined, lspError(id, LSP_ERROR.invalidParams, 'missing "command"'));
  const args = Array.isArray(params.arguments) ? params.arguments : [];
  switch (command) {
    case 'mercury.prompt':
      return await handlePrompt(agent, id, notification, lspPromptText(args[0]), emit);
    case 'mercury.tools.list':
      return respond(id, notification, { tools: toolList(agent) });
    case 'mercury.tools.call': {
      const spec = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}) as Record<string, unknown>;
      return await callTool(agent, id, notification, spec);
    }
    default:
      return respond(id, notification, undefined, lspError(id, LSP_ERROR.invalidParams, `unknown command "${command}"`));
  }
}

async function handlePrompt(
  agent: LspAgent,
  id: LspId | null,
  notification: boolean,
  input: string,
  emit: LspEmit,
): Promise<LspResponse | null> {
  if (!input.trim()) return respond(id, notification, undefined, lspError(id, LSP_ERROR.invalidParams, 'prompt has no text content'));
  const token = `mercury/${typeof id === 'string' || typeof id === 'number' ? id : 'prompt'}`;
  // Stream agent output / tool-call progress to the client as $/progress notifications.
  const onUpdate = (update: LspUpdate) => emit('$/progress', { token, value: update });
  const r = await agent.runPrompt(input, { sessionId: 'lsp', onUpdate });
  if (r.output) onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: r.output } });
  return respond(id, notification, { output: r.output, stopReason: r.stopReason ?? 'end_turn' });
}

function toolList(agent: LspAgent): Array<{ name: string; description: string; inputSchema: unknown }> {
  const specs = agent.toolSpecs ? agent.toolSpecs() : [];
  return specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}

async function callTool(
  agent: LspAgent,
  id: LspId | null,
  notification: boolean,
  params: Record<string, unknown>,
): Promise<LspResponse | null> {
  if (!agent.callTool) return respond(id, notification, undefined, lspError(id, LSP_ERROR.methodNotFound, 'tool invocation is not available'));
  const name = typeof params.name === 'string' ? params.name : undefined;
  if (!name) return respond(id, notification, undefined, lspError(id, LSP_ERROR.invalidParams, 'missing "name"'));
  const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
  const r = await agent.callTool(name, args);
  return respond(id, notification, { content: [{ type: 'text', text: r.content }], isError: r.isError === true });
}

/** A request before `initialize` is an error; a notification before init is silently dropped. */
function guardInit(id: LspId | null, notification: boolean): LspResponse | null {
  return respond(id, notification, undefined, lspError(id, LSP_ERROR.serverNotInitialized, 'server not initialized — call "initialize" first'));
}

/**
 * Shape a handler's outcome into the right thing to return: `null` for notifications, the prepared error
 * if one is given, otherwise a success response wrapping `result`.
 */
function respond(id: LspId | null, notification: boolean, result: unknown, error?: LspResponse): LspResponse | null {
  if (notification) return null;
  if (error) return error;
  return lspResult(id, result);
}

// ── thin stdio transport ─────────────────────────────────────────────────────

/**
 * Serve LSP over Content-Length-framed JSON-RPC on a pair of streams (stdio by default). Reads framed
 * messages from the input, dispatches each, and writes framed responses + `$/progress` notifications
 * back. Resolves when the client sends `exit` or the input stream ends.
 */
export function serveLspStdio(
  agent: LspAgent,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
  opts: { version?: string } = {},
): Promise<void> {
  const state = createLspState({ version: opts.version });
  const write = (obj: unknown) => io.output.write(encodeLspMessage(obj));
  const emit: LspEmit = (method, params) => write({ jsonrpc: '2.0', method, params });

  let chain: Promise<void> = Promise.resolve();
  let buffer: Buffer = Buffer.alloc(0);

  return new Promise<void>((resolve, reject) => {
    const finish = () => chain.then(resolve, reject);
    io.input.on('data', (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
      const { messages, rest } = decodeLspFrames(buffer);
      buffer = rest;
      for (const body of messages) {
        chain = chain.then(async () => {
          const exit = await processLspFrame(state, agent, body, emit, write);
          if (exit) resolve(chain);
        });
      }
    });
    io.input.on('error', reject);
    io.input.on('end', finish);
  });
}

/**
 * Parse + dispatch one decoded frame body and write a response if the message was a request. Returns
 * `true` when the message was an `exit` notification (the transport should stop). Exported for tests.
 */
export async function processLspFrame(
  state: LspServerState,
  agent: LspAgent,
  body: string,
  emit: LspEmit,
  write: (obj: unknown) => void,
): Promise<boolean> {
  const parsed = parseLspMessage(body);
  if (isLspResponse(parsed)) {
    write(parsed);
    return false;
  }
  const res = await handleLspMessage(state, agent, parsed, emit);
  if (res) write(res);
  return parsed.method === 'exit';
}
