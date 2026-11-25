# Optionale Integrationen

v1.8.0 fügt **14 optionale MCP-Integrations-Presets** zu den fünf Kern-Presets hinzu
(`filesystem`, `fetch`, `github`, `git`, `sqlite`). Jede Integration ist **standardmäßig
deaktiviert** — nichts verbindet sich, bis Sie es ausdrücklich aktivieren. Jedes Preset ist ein
fertiger, geheimnisfreier `mcp.servers`-Eintrag: Er verweist auf `${ENV_VAR}`-Platzhalter, die beim
Verbinden aus der Umgebung aufgelöst und niemals in der Konfiguration gespeichert werden.

## Integrationen verwalten

- `mercury mcp presets` — listet jedes Preset mit Herkunft, npm-Paket, benötigten Umgebungsvariablen und Zustand auf.
- `mercury mcp enable <name> [--name myname] [--connect]` — schreibt das Preset als **aktiviert** in `mcp.servers`.
- `mercury mcp disable <name>` — setzt `enabled: false` und trennt die Verbindung (der Eintrag bleibt erhalten).
- `mercury mcp status` — zeigt verbundene Server und welche konfigurierten Server aktiviert sind.

In der Web-Oberfläche listet das Admin-Panel **Integrations** alle Presets mit Aktivieren/Deaktivieren-
Schaltflächen und einer Warnung auf, wenn eine erforderliche Umgebungsvariable nicht gesetzt ist.

Legen Sie Geheimnisse in `~/.mercury/.env` ab (z. B. `SLACK_BOT_TOKEN=…`). Starten Sie Mercury nach
dem Aktivieren neu (oder verbinden Sie neu), damit `connectAll` den neu aktivierten Server erkennt.
`mercury mcp enable` meldet jede noch nicht gesetzte erforderliche Variable.

## Herkunft (Provenance)

- **official** — ein aktuell gepflegter First-Party-Server (noch aktiver MCP-Referenzserver oder der eigene Server eines Anbieters).
- **official-archived** — ein First-Party-Referenzserver, der weiterhin auf npm veröffentlicht wird, aber jetzt im MCP-Repo `servers-archived` liegt. Er funktioniert, wird aber upstream nicht mehr aktiv gepflegt.
- **community** — ein bekannter Drittanbieter-Server. Auf npm als vorhanden verifiziert, aber nicht offiziell vom Anbieter; prüfen Sie ihn, bevor Sie ihm Zugangsdaten anvertrauen.

Jedes Paket unten wurde auf npm verifiziert (`npm view <pkg> version`). Keiner ist ein erfundener
oder Platzhalter-Name. Alle Preset-Server werden als `untrusted` registriert, sodass ihre Ausgabe
weiterhin der Taint-Verfolgung und Freigaberichtlinie von Mercury unterliegt.

## Katalog

| Integration | Preset-Name | Paket | Herkunft | Erforderliche Umgebungsvariablen |
|---|---|---|---|---|
| Google Calendar | `google-calendar` | `@cocal/google-calendar-mcp` | community | `GOOGLE_OAUTH_CREDENTIALS` |
| CalDAV | `caldav` | `caldav-mcp` | community | `CALDAV_BASE_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD` |
| Slack | `slack` | `@modelcontextprotocol/server-slack` | official-archived | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| Playwright | `playwright` | `@playwright/mcp` | official | (keine) |
| Puppeteer | `puppeteer` | `@modelcontextprotocol/server-puppeteer` | official-archived | (keine) |
| Brave Search | `brave-search` | `@modelcontextprotocol/server-brave-search` | official-archived | `BRAVE_API_KEY` |
| Tavily | `tavily` | `tavily-mcp` | official | `TAVILY_API_KEY` |
| Redis | `redis` | `@modelcontextprotocol/server-redis` | official-archived | `REDIS_URL` |
| PostgreSQL | `postgres` | `@modelcontextprotocol/server-postgres` | official-archived | `POSTGRES_URL` |
| Discord | `discord` | `mcp-discord` | community | `DISCORD_TOKEN` |
| Microsoft Teams | `teams` | `@floriscornel/teams-mcp` | community | `TEAMS_MCP_CLIENT_ID`, `TEAMS_MCP_TENANT_ID` |
| Notion | `notion` | `@notionhq/notion-mcp-server` | official | `NOTION_TOKEN` |
| Confluence | `confluence` | `@aashari/mcp-server-atlassian-confluence` | community | `ATLASSIAN_SITE_NAME`, `ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN` |
| Obsidian | `obsidian` | `obsidian-mcp` | community | `OBSIDIAN_VAULT_PATH` |

## Beispiel

```console
$ export SLACK_BOT_TOKEN=xoxb-… SLACK_TEAM_ID=T0123
$ mercury mcp enable slack
enabled preset 'slack' as mcp server 'slack'
$ mercury mcp status
$ mercury mcp disable slack
```

Integrationen laufen über npx (Node-Pakete) oder uvx (die beiden Python-Kern-Presets). Stellen Sie
sicher, dass der jeweilige Runner installiert ist. Live-Konnektivität erfordert echte Zugangsdaten
und liegt außerhalb des automatisierten Testumfangs — die Testsuite prüft nur die Verdrahtung.
