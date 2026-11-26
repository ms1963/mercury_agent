# LSP server (Language Server Protocol)

Expose Mercury over the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
(LSP) so LSP-capable *clients* — editors and IDEs such as VS Code, Neovim and Zed — can reach the Mercury
agent and tool surface through their built-in language-server plumbing. LSP **complements the MCP and ACP
servers**: where `mercury mcp serve` lets MCP clients call Mercury's tools and `mercury acp serve` lets an
ACP client prompt the agent, `mercury lsp serve` exposes the same underlying surface to an LSP client.

## Run the server — `mercury lsp serve`

LSP speaks JSON-RPC 2.0 over a bidirectional stream, framed with an HTTP-style header block
(`Content-Length: N\r\n\r\n<json>`, where `N` is the UTF-8 **byte** length of the body) rather than ACP's
one-message-per-line framing. Mercury serves it over **stdio**: framed requests arrive on stdin, framed
responses and `$/progress` notifications are written to stdout. The process runs until the client sends
`exit` or stdin closes.

- `mercury lsp serve` — start the stdio server bound to the local admin user.
- `mercury lsp serve --user <name>` — bind the session to a specific Mercury user.

This is the mode an LSP client launches as a subprocess. You normally configure your editor to run
`mercury lsp serve` rather than invoking it by hand.

## Inspect the protocol surface

- `mercury lsp` / `mercury lsp info` — show the targeted protocol version, the advertised `serverInfo` and
  capabilities, and the implemented method surface. Add `--json` for the structured form (including the
  reachable tool names).
- `mercury lsp methods` — list the JSON-RPC methods this server handles (`--json` for structured output).

## Wire surface (JSON-RPC 2.0 over stdio, Content-Length framed)

| Method | Kind | Purpose |
|---|---|---|
| `initialize` | request | Negotiate capabilities → `{ capabilities, serverInfo }`. |
| `initialized` | notification | Client acknowledgement after `initialize`. |
| `shutdown` | request | Request a clean shutdown (replies with `null`). |
| `exit` | notification | End the serve loop. |
| `textDocument/didOpen` | notification | Track an opened document (uri → version + text). |
| `textDocument/didChange` | notification | Apply a full-text change to a tracked document. |
| `textDocument/didClose` | notification | Stop tracking a document. |
| `workspace/executeCommand` | request | Run a Mercury command: `mercury.prompt`, `mercury.tools.list`, `mercury.tools.call`. |
| `_mercury/agent/prompt` | request | Run one agent prompt turn (vendor extension). |
| `_mercury/tools/list` | request | List Mercury tool specs (vendor extension). |
| `_mercury/tools/call` | request | Invoke one Mercury tool by name (vendor extension). |

While an agent turn runs (`mercury.prompt` or `_mercury/agent/prompt`), the agent streams `$/progress`
notifications back to the client — tool-call progress plus the final `agent_message_chunk` — and the
request then answers with `{ output, stopReason }` (`end_turn`, `cancelled`, `error`).

### Document sync

The server advertises **full** document sync (`textDocumentSync.change = 1`): each `textDocument/didChange`
carries the whole new text, and the server keeps the latest version + text per uri. Opened documents are
tracked from `didOpen` and dropped on `didClose`.

## Capabilities advertised in `initialize`

```json
{
  "capabilities": {
    "textDocumentSync": { "openClose": true, "change": 1 },
    "executeCommandProvider": { "commands": ["mercury.prompt", "mercury.tools.list", "mercury.tools.call"] }
  },
  "serverInfo": { "name": "mercury", "version": "1.9.0" }
}
```

## Architecture

The core logic lives in `packages/core/src/lsp/lsp.ts`, split into **pure** functions — the Content-Length
framing (`encodeLspMessage` / `decodeLspFrames`, which handle partial buffers and multiple messages in one
chunk), the JSON-RPC parser and the request dispatch (unit-testable with an injected agent stub and an
injected notification sink) — plus a thin stdio transport (`serveLspStdio`) that does the framing over real
streams. The runtime adapter `m.lspAgent(principal)` binds a principal via closure — exactly as the MCP
server's `serveStdio` and the ACP server's adapter do — and exposes the same agent-run + tool-call surface
as the MCP backend (its `LspAgent` type aliases the ACP `AcpAgent`).

## Status / honesty

The framing, every method handler and the error paths are exercised offline and deterministically by
`tests/lsp.test.ts` against injected stubs and in-memory streams. The `$/progress` streaming is wired
through the injected update sink and tested with a stub that drives it; the runtime adapter returns the
agent's final output as a single `agent_message_chunk`. The server has **not** been exercised against a
real external LSP client (e.g. VS Code / Zed) — only against the deterministic offline tests.
