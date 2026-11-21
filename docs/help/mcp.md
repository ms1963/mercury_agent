# Model Context Protocol

Mercury is both an MCP **client** and **server**.

- Client: add servers under `mcp.servers` in config or the Tools & MCP panel (stdio command or HTTP URL). Their tools appear as `mcp_<server>_<tool>`.
- Server: `mercury serve` exposes Mercury's tools at `/mcp` (streamable HTTP). Create a token with the `mcp` scope: `mercury token create claude --scopes mcp`, then send `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` for desktop clients.

## Curated presets

Mercury ships curated connector presets so you don't have to remember command lines:
`filesystem`, `fetch`, `github`, `git`, `sqlite`. List and inspect them:

- `mercury mcp presets` — list the presets and the env vars each one needs.
- `mercury mcp status` — show configured servers and whether they are connected.
- `mercury mcp enable <preset> [--name myname]` — add a preset to `mcp.servers` in config.

Presets never embed secrets. They reference placeholders like `${GITHUB_TOKEN}`,
`${MCP_FS_ROOT}`, `${MCP_GIT_REPO}` and `${MCP_SQLITE_DB}`, which are resolved from the
environment at connect time. `mercury mcp enable` reports any required variables that are
unset so you can export them before connecting. All preset servers are registered as
`untrusted` — their tool output is treated as untrusted and stays subject to policy/approval.
