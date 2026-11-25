# Model Context Protocol

Mercury ist sowohl ein MCP-**Client** als auch ein MCP-**Server**.

- Client: Fügen Sie Server unter `mcp.servers` in der Konfiguration oder im Panel „Tools & MCP" hinzu (stdio-Befehl oder HTTP-URL). Ihre Tools erscheinen als `mcp_<server>_<tool>`.
- Server: `mercury serve` stellt die Tools von Mercury unter `/mcp` bereit (streambares HTTP). Erstellen Sie ein Token mit dem Scope `mcp`: `mercury token create claude --scopes mcp`, und senden Sie dann `Authorization: Bearer mrc_…`.
- Stdio: `mercury mcp serve` für Desktop-Clients.

## Kuratierte Presets

Mercury liefert kuratierte Connector-Presets mit, damit Sie sich keine Befehlszeilen merken müssen.
Die Kern-Presets sind `filesystem`, `fetch`, `github`, `git`, `sqlite`, und v1.8.0 fügt **14 optionale
Integrationen** hinzu — siehe das eigene Hilfethema `integrations`. Verwaltung:

- `mercury mcp presets` — listet jedes Preset mit Herkunft, benötigten Umgebungsvariablen und Zustand auf.
- `mercury mcp status` — zeigt verbundene Server sowie welche konfigurierten Server aktiviert sind.
- `mercury mcp enable <preset> [--name myname] [--connect]` — schreibt ein Preset in `mcp.servers`
  und markiert es als **aktiviert**.
- `mercury mcp disable <server>` — setzt `enabled: false` und trennt die Verbindung (die Konfiguration bleibt erhalten).

Jedes Preset ist **standardmäßig deaktiviert** — das Aktivieren ist immer eine ausdrückliche Aktion,
und `connectAll` überspringt jeden Server, dessen `enabled` false ist. Presets enthalten niemals
Geheimnisse. Sie verweisen auf Platzhalter wie `${GITHUB_TOKEN}`, `${SLACK_BOT_TOKEN}` oder
`${POSTGRES_URL}`, die beim Verbinden aus der Umgebung aufgelöst werden; legen Sie sie in
`~/.mercury/.env` ab. `mercury mcp enable` meldet alle erforderlichen Variablen, die nicht gesetzt
sind. Alle Preset-Server werden als `untrusted` registriert — ihre Tool-Ausgabe gilt als nicht
vertrauenswürdig und unterliegt weiterhin Richtlinie/Freigabe.
