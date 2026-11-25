# Model Context Protocol

Mercury is both an MCP **client** and **server**.

- Client: add servers under `mcp.servers` in config or the Tools & MCP panel (stdio command or HTTP URL). Their tools appear as `mcp_<server>_<tool>`.
- Server: `mercury serve` exposes Mercury's tools at `/mcp` (streamable HTTP). Create a token with the `mcp` scope: `mercury token create claude --scopes mcp`, then send `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` for desktop clients.

## Curated presets

Mercury ships curated connector presets so you don't have to remember command lines. The core
presets are `filesystem`, `fetch`, `github`, `git`, `sqlite`, and v1.8.0 adds **14 optional
integrations** — see the dedicated `integrations` help topic. Manage them with:

- `mercury mcp presets` — list every preset with its provenance, required env vars and on/off state.
- `mercury mcp status` — show connected servers plus which configured servers are enabled.
- `mercury mcp enable <preset> [--name myname] [--connect]` — write a preset into `mcp.servers`
  and mark it **enabled**.
- `mercury mcp disable <server>` — set `enabled: false` and disconnect (the config is retained).

Every preset is **disabled by default** — enabling is always an explicit action, and `connectAll`
skips any server whose `enabled` is false. Presets never embed secrets. They reference placeholders
like `${GITHUB_TOKEN}`, `${SLACK_BOT_TOKEN}` or `${POSTGRES_URL}`, which are resolved from the
environment at connect time; put them in `~/.mercury/.env`. `mercury mcp enable` reports any required
variables that are unset. All preset servers are registered as `untrusted` — their tool output is
treated as untrusted and stays subject to policy/approval.
