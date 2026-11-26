/**
 * Mercury as an **ACP server** (Tier-3 gap #9).
 *
 * The {@link https://agentclientprotocol.com | Agent Client Protocol} (ACP) is a JSON-RPC 2.0 standard
 * that lets external *clients* (editors / IDEs such as Zed) drive an *agent*. Where the MCP server
 * (`packages/mcp`) exposes Mercury so that MCP clients can call Mercury's tools/skills, the ACP server
 * exposes the SAME underlying agent + tool capabilities over the ACP wire so an ACP client can open a
 * session and prompt Mercury directly.
 *
 * ## Wire format
 * ACP speaks JSON-RPC 2.0 over a bidirectional stream (stdio: newline-delimited JSON, one message per
 * line). The client drives the lifecycle:
 *   - `initialize`            — negotiate the integer protocol version and exchange capabilities.
 *   - `session/new`           — open a conversation session (returns a `sessionId`).
 *   - `session/prompt`        — send a user turn (array of content blocks); the agent processes it and
 *                               streams `session/update` **notifications** back (agent message chunks,
 *                               tool calls), then answers with a `stopReason`.
 *   - `session/cancel`        — a notification that aborts the in-flight turn.
 *   - `session/list`          — list open sessions (advertised capability).
 *
 * Mercury also exposes two underscore-prefixed **extension** methods (ACP reserves the `_` prefix for
 * vendor extensions) so a client can reach the full tool surface the MCP server exposes:
 *   - `_mercury/tools/list`   — list Mercury tool specs.
 *   - `_mercury/tools/call`   — invoke one Mercury tool by name.
 *
 * ## Design (house style)
 * The module is split into **pure** request-handling/dispatch functions (no fs/network — fully
 * unit-testable with an injected {@link AcpAgent} stub and an injected `emit` sink for notifications)
 * plus a thin stdio transport ({@link serveAcpStdio}) that frames newline-delimited JSON.
 *
 * ## Honesty
 * The pure dispatch, every method handler, JSON-RPC framing and the error paths are exercised offline
 * by `tests/acp.test.ts` against injected stubs. The `session/update` streaming of tool calls is wired
 * through the injected `onUpdate` sink and tested with a stub that drives it; the runtime adapter that
 * binds a real Mercury agent to this server returns the agent's final output as a single
 * `agent_message_chunk`. It has **not** been exercised against a real external ACP client (e.g. Zed) —
 * only against the deterministic offline tests.
 */
import type { Readable, Writable } from 'node:stream';
import { errorMessage } from '../types/common.js';
import type { ToolSpec } from '../types/messages.js';

/** The integer ACP protocol version this server implements. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 standard error codes (plus a couple ACP-relevant ones). */
export const ACP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
} as const;

/** A JSON-RPC id (string or integer; never null per ACP). */
export type AcpId = string | number;

/** A parsed JSON-RPC request or notification (no `id` ⇒ notification). */
export interface AcpRequest {
  jsonrpc: '2.0';
  id?: AcpId;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC response (success xor error). */
export interface AcpResponse {
  jsonrpc: '2.0';
  id: AcpId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Why a prompt turn stopped. Mirrors ACP stop reasons. */
export type AcpStopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error';

/** One content block of a prompt or an agent message (a subset of the ACP/MCP content union). */
export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A `session/update` sub-notification payload the agent streams back during a turn. */
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; status: string; rawInput?: unknown }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: string; content?: AcpContentBlock[] };

/** Options handed to the agent for one prompt turn. */
export interface AcpPromptOptions {
  sessionId: string;
  /** Abort signal raised when the client sends `session/cancel`. */
  signal?: AbortSignal;
  /** Push a `session/update` sub-notification (streaming chunks / tool calls). */
  onUpdate?: (update: AcpSessionUpdate) => void;
}

/**
 * What the ACP server needs from Mercury — the SAME underlying capabilities the MCP backend exposes
 * (agent run + tool surface). Implemented by the runtime, which binds a fixed principal via closure
 * (exactly as `serveStdio` binds a principal for the MCP server). Kept principal-free here so the core
 * dispatch stays decoupled from auth.
 */
export interface AcpAgent {
  /** Run one prompt turn. `output` is the final assistant text. */
  runPrompt(input: string, opts: AcpPromptOptions): Promise<{ output: string; stopReason?: AcpStopReason }>;
  /** List the Mercury tool specs reachable over ACP (optional extension surface). */
  toolSpecs?(): ToolSpec[];
  /** Invoke one Mercury tool by name (optional extension surface). */
  callTool?(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
}

/** One open ACP session. */
export interface AcpSession {
  id: string;
  cwd?: string;
  /** Monotonic counter used to mint stable session ids when no id generator is injected. */
  turns: number;
  /** Set when the client cancels the in-flight turn. */
  cancelled: boolean;
}

/** Server state threaded through the pure dispatch (no globals). */
export interface AcpServerState {
  initialized: boolean;
  protocolVersion: number;
  sessions: Map<string, AcpSession>;
  /** Injected id generator (deterministic in tests). */
  nextSessionId: () => string;
}

/** Create a fresh server state. Inject `nextSessionId` for deterministic tests. */
export function createAcpState(nextSessionId?: () => string): AcpServerState {
  let n = 0;
  return {
    initialized: false,
    protocolVersion: ACP_PROTOCOL_VERSION,
    sessions: new Map(),
    nextSessionId: nextSessionId ?? (() => `sess_${++n}`),
  };
}

/** A notification sink: the transport serializes and writes these to the client. */
export type AcpEmit = (method: string, params: Record<string, unknown>) => void;

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Build a success response. */
export function acpResult(id: AcpId | null, result: unknown): AcpResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build an error response. */
export function acpError(id: AcpId | null, code: number, message: string, data?: unknown): AcpResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * Parse one raw JSON-RPC message line. Returns the parsed request or an {@link AcpResponse} error
 * (parse / invalid-request) ready to send back. Pure — no IO.
 */
export function parseAcpMessage(line: string): AcpRequest | AcpResponse {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return acpError(null, ACP_ERROR.parse, 'Parse error: invalid JSON');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return acpError(null, ACP_ERROR.invalidRequest, 'Invalid Request: expected a JSON-RPC object');
  }
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') {
    return acpError(idOf(m), ACP_ERROR.invalidRequest, 'Invalid Request: jsonrpc must be "2.0"');
  }
  if (typeof m.method !== 'string' || m.method.length === 0) {
    return acpError(idOf(m), ACP_ERROR.invalidRequest, 'Invalid Request: missing method');
  }
  const req: AcpRequest = { jsonrpc: '2.0', method: m.method };
  if (m.id !== undefined && m.id !== null) req.id = m.id as AcpId;
  if (m.params !== undefined) {
    if (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params)) {
      return acpError(idOf(m), ACP_ERROR.invalidParams, 'Invalid params: expected an object');
    }
    req.params = m.params as Record<string, unknown>;
  }
  return req;
}

function idOf(m: Record<string, unknown>): AcpId | null {
  const id = m.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** A value is a response (already-built error) rather than a request. */
export function isAcpResponse(v: AcpRequest | AcpResponse): v is AcpResponse {
  return 'result' in v || 'error' in v;
}

/** Concatenate the text of a prompt's content blocks (ACP joins adjacent text without separators). */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (b && typeof b === 'object' && typeof (b as AcpContentBlock).text === 'string' ? (b as AcpContentBlock).text! : ''))
    .join('');
}

// ── method dispatch ──────────────────────────────────────────────────────────

/**
 * Handle one parsed JSON-RPC message. Pure with respect to IO: all side effects are the returned
 * response and any `emit`ted notifications. Returns `null` for notifications (no response expected).
 */
export async function handleAcpMessage(
  state: AcpServerState,
  agent: AcpAgent,
  req: AcpRequest,
  emit: AcpEmit,
): Promise<AcpResponse | null> {
  const id = req.id ?? null;
  const notification = req.id === undefined;
  const params = req.params ?? {};

  try {
    switch (req.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'number' ? params.protocolVersion : ACP_PROTOCOL_VERSION;
        state.protocolVersion = Math.min(ACP_PROTOCOL_VERSION, requested);
        state.initialized = true;
        return respond(id, notification, {
          protocolVersion: state.protocolVersion,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: { list: true },
          },
          // No auth: an empty authMethods array means auth/login must not be called.
          authMethods: [],
          agentInfo: { name: 'mercury', version: '1' },
        });
      }

      case 'authenticate':
      case 'auth/login':
      case 'auth/logout':
        return respond(id, notification, undefined, acpError(id, ACP_ERROR.methodNotFound, `${req.method} is not supported (this agent advertises no auth methods)`));

      case 'session/new': {
        if (!state.initialized) return guardInit(id, notification);
        const sid = state.nextSessionId();
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        state.sessions.set(sid, { id: sid, cwd, turns: 0, cancelled: false });
        return respond(id, notification, { sessionId: sid });
      }

      case 'session/load':
        return respond(id, notification, undefined, acpError(id, ACP_ERROR.methodNotFound, 'session/load is not supported (loadSession capability is false)'));

      case 'session/list': {
        if (!state.initialized) return guardInit(id, notification);
        return respond(id, notification, { sessions: [...state.sessions.values()].map((s) => ({ sessionId: s.id, cwd: s.cwd })) });
      }

      case 'session/prompt':
        return await handlePrompt(state, agent, id, notification, params, emit);

      case 'session/cancel': {
        const sid = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        const session = sid ? state.sessions.get(sid) : undefined;
        if (session) session.cancelled = true;
        // Notification: no response.
        return null;
      }

      case '_mercury/tools/list': {
        if (!state.initialized) return guardInit(id, notification);
        const specs = agent.toolSpecs ? agent.toolSpecs() : [];
        return respond(id, notification, { tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      }

      case '_mercury/tools/call': {
        if (!state.initialized) return guardInit(id, notification);
        if (!agent.callTool) return respond(id, notification, undefined, acpError(id, ACP_ERROR.methodNotFound, 'tool invocation is not available'));
        const name = typeof params.name === 'string' ? params.name : undefined;
        if (!name) return respond(id, notification, undefined, acpError(id, ACP_ERROR.invalidParams, 'missing "name"'));
        const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
        const r = await agent.callTool(name, args);
        return respond(id, notification, { content: [{ type: 'text', text: r.content }], isError: r.isError === true });
      }

      default:
        return respond(id, notification, undefined, acpError(id, ACP_ERROR.methodNotFound, `Method not found: ${req.method}`));
    }
  } catch (err) {
    if (notification) return null;
    return acpError(id, ACP_ERROR.internal, errorMessage(err));
  }
}

async function handlePrompt(
  state: AcpServerState,
  agent: AcpAgent,
  id: AcpId | null,
  notification: boolean,
  params: Record<string, unknown>,
  emit: AcpEmit,
): Promise<AcpResponse | null> {
  if (!state.initialized) return guardInit(id, notification);
  const sid = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  if (!sid) return respond(id, notification, undefined, acpError(id, ACP_ERROR.invalidParams, 'missing "sessionId"'));
  const session = state.sessions.get(sid);
  if (!session) return respond(id, notification, undefined, acpError(id, ACP_ERROR.invalidParams, `unknown session "${sid}"`));

  const input = promptText(params.prompt);
  if (!input.trim()) return respond(id, notification, undefined, acpError(id, ACP_ERROR.invalidParams, 'prompt has no text content'));

  session.turns += 1;
  session.cancelled = false;
  const controller = new AbortController();
  const onUpdate = (update: AcpSessionUpdate) => emit('session/update', { sessionId: sid, update });

  const r = await agent.runPrompt(input, { sessionId: sid, signal: controller.signal, onUpdate });

  if (session.cancelled) return respond(id, notification, { stopReason: 'cancelled' as AcpStopReason });

  // Stream the final assistant text as an agent_message_chunk, then answer with the stop reason.
  if (r.output) onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: r.output } });
  return respond(id, notification, { stopReason: r.stopReason ?? 'end_turn' });
}

/** A request before `initialize` is an error; a notification before init is silently dropped. */
function guardInit(id: AcpId | null, notification: boolean): AcpResponse | null {
  return respond(id, notification, undefined, acpError(id, ACP_ERROR.invalidRequest, 'server not initialized — call "initialize" first'));
}

/**
 * Shape a handler's outcome into the right thing to return: `null` for notifications, the prepared
 * error if one is given, otherwise a success response wrapping `result`.
 */
function respond(id: AcpId | null, notification: boolean, result: unknown, error?: AcpResponse): AcpResponse | null {
  if (notification) return null;
  if (error) return error;
  return acpResult(id, result);
}

// ── thin stdio transport ─────────────────────────────────────────────────────

/**
 * Serve ACP over newline-delimited JSON on a pair of streams (stdio by default). Reads one JSON-RPC
 * message per line, dispatches it, and writes responses + `session/update` notifications back as
 * newline-delimited JSON. Resolves when the input stream ends.
 */
export function serveAcpStdio(
  agent: AcpAgent,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const state = createAcpState();
  const write = (obj: unknown) => io.output.write(`${JSON.stringify(obj)}\n`);
  const emit: AcpEmit = (method, params) => write({ jsonrpc: '2.0', method, params });

  // Serialize message handling so responses are written in order.
  let chain: Promise<void> = Promise.resolve();
  let buffer = '';

  return new Promise<void>((resolve, reject) => {
    io.input.setEncoding('utf8');
    io.input.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        chain = chain.then(() => processLine(state, agent, line, emit, write));
      }
    });
    io.input.on('error', reject);
    io.input.on('end', () => {
      chain.then(resolve, reject);
    });
  });
}

/** Parse + dispatch one line and write a response if the message was a request. Exported for tests. */
export async function processLine(
  state: AcpServerState,
  agent: AcpAgent,
  line: string,
  emit: AcpEmit,
  write: (obj: unknown) => void,
): Promise<void> {
  const parsed = parseAcpMessage(line);
  if (isAcpResponse(parsed)) {
    write(parsed);
    return;
  }
  const res = await handleAcpMessage(state, agent, parsed, emit);
  if (res) write(res);
}
