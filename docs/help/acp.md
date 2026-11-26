# ACP server (Agent Client Protocol)

Expose Mercury over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) so external
*clients* — editors and IDEs such as Zed — can open a session and drive the Mercury agent. ACP
**complements the MCP server**: where `mercury mcp serve` lets MCP clients call Mercury's tools,
`mercury acp serve` lets an ACP client prompt the Mercury agent and reach the same underlying tool
surface.

## Run the server — `mercury acp serve`

ACP speaks JSON-RPC 2.0 over a bidirectional stream. Mercury serves it over **stdio** as
newline-delimited JSON (one message per line): requests arrive on stdin, responses and
`session/update` notifications are written to stdout. The process runs until stdin closes.

- `mercury acp serve` — start the stdio server bound to the local admin user.
- `mercury acp serve --user <name>` — bind the session to a specific Mercury user.

This is the mode an ACP client launches as a subprocess. You normally configure your editor to run
`mercury acp serve` rather than invoking it by hand.

## Inspect the protocol surface

- `mercury acp` / `mercury acp info` — show the negotiated protocol version, advertised capabilities and
  the implemented method surface. Add `--json` for the structured form (including the reachable tool
  names).
- `mercury acp methods` — list the JSON-RPC methods this server handles (`--json` for structured output).

## Wire surface (JSON-RPC 2.0 over stdio)

| Method | Kind | Purpose |
|---|---|---|
| `initialize` | request | Negotiate the integer protocol version and exchange capabilities. No auth methods are advertised. |
| `session/new` | request | Open a conversation session → `{ sessionId }`. |
| `session/list` | request | List open sessions. |
| `session/prompt` | request | Run one prompt turn; streams `session/update` notifications, then answers `{ stopReason }`. |
| `session/cancel` | notification | Abort the in-flight turn for a session. |
| `_mercury/tools/list` | request | List Mercury tool specs (vendor extension; ACP reserves the `_` prefix). |
| `_mercury/tools/call` | request | Invoke one Mercury tool by name (vendor extension). |

During a `session/prompt` turn the agent streams `session/update` notifications back to the client:
`agent_message_chunk` (assistant text) plus any `tool_call` / `tool_call_update` the agent emits. When
the turn ends, the `session/prompt` response carries a `stopReason` (`end_turn`, `cancelled`, `error`).

### Not supported (by design)

- `session/load` — the agent advertises `loadSession: false`; sessions are not resumable across restarts.
- `auth/login` / `auth/logout` / `authenticate` — the agent advertises an empty `authMethods` array, so
  these must not be called (they return a JSON-RPC *method not found* error). Authentication is bound at
  launch via `--user`.

## Capabilities advertised in `initialize`

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "sessionCapabilities": { "list": true }
  },
  "authMethods": []
}
```

## Architecture

The core logic lives in `packages/core/src/acp/acp.ts`, split into **pure** request parsing/dispatch
functions (unit-testable with an injected agent stub and an injected notification sink) and a thin stdio
transport (`serveAcpStdio`) that frames newline-delimited JSON. The runtime adapter
`m.acpAgent(principal)` binds a principal via closure — exactly as the MCP server's `serveStdio` binds a
principal — and exposes the same agent-run + tool-call surface as the MCP backend.

## Status / honesty

Every method handler, the JSON-RPC framing and the error paths are exercised offline and deterministically
by `tests/acp.test.ts` against injected stubs. The streaming of tool-call `session/update` notifications
is wired through the injected update sink and tested with a stub that drives it; the runtime adapter
returns the agent's final output as a single `agent_message_chunk`. The server has **not** been exercised
against a real external ACP client (e.g. Zed) — only against the deterministic offline tests.
