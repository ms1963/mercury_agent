# Model Context Protocol

Mercury is both an MCP **client** and **server**.

- Client: add servers under `mcp.servers` in config or the Tools & MCP panel (stdio command or HTTP URL). Their tools appear as `mcp_<server>_<tool>`.
- Server: `mercury serve` exposes Mercury's tools at `/mcp` (streamable HTTP). Create a token with the `mcp` scope: `mercury token create claude --scopes mcp`, then send `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` for desktop clients.
