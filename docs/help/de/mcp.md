# Model Context Protocol

Mercury ist sowohl ein MCP-**Client** als auch ein MCP-**Server**.

- Client: Fügen Sie Server unter `mcp.servers` in der Konfiguration oder im Panel „Tools & MCP" hinzu (stdio-Befehl oder HTTP-URL). Ihre Tools erscheinen als `mcp_<server>_<tool>`.
- Server: `mercury serve` stellt die Tools von Mercury unter `/mcp` bereit (streambares HTTP). Erstellen Sie ein Token mit dem Scope `mcp`: `mercury token create claude --scopes mcp`, und senden Sie dann `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` für Desktop-Clients.

## Kuratierte Presets

Mercury liefert kuratierte Connector-Presets mit, damit Sie sich keine Befehlszeilen merken müssen:
`filesystem`, `fetch`, `github`, `git`, `sqlite`. Auflisten und prüfen:

- `mercury mcp presets` — listet die Presets und die jeweils benötigten Umgebungsvariablen auf.
- `mercury mcp status` — zeigt konfigurierte Server und ob sie verbunden sind.
- `mercury mcp enable <preset> [--name myname]` — fügt ein Preset zu `mcp.servers` in der Konfiguration hinzu.

Presets enthalten niemals Geheimnisse. Sie verweisen auf Platzhalter wie `${GITHUB_TOKEN}`,
`${MCP_FS_ROOT}`, `${MCP_GIT_REPO}` und `${MCP_SQLITE_DB}`, die beim Verbinden aus der Umgebung
aufgelöst werden. `mercury mcp enable` meldet alle erforderlichen Variablen, die nicht gesetzt sind,
damit Sie sie vor dem Verbinden exportieren können. Alle Preset-Server werden als `untrusted`
registriert — ihre Tool-Ausgabe gilt als nicht vertrauenswürdig und unterliegt weiterhin
Richtlinie/Freigabe.
