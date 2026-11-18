# Model Context Protocol

Mercury ist sowohl ein MCP-**Client** als auch ein MCP-**Server**.

- Client: Fügen Sie Server unter `mcp.servers` in der Konfiguration oder im Panel „Tools & MCP" hinzu (stdio-Befehl oder HTTP-URL). Ihre Tools erscheinen als `mcp_<server>_<tool>`.
- Server: `mercury serve` stellt die Tools von Mercury unter `/mcp` bereit (streambares HTTP). Erstellen Sie ein Token mit dem Scope `mcp`: `mercury token create claude --scopes mcp`, und senden Sie dann `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` für Desktop-Clients.
