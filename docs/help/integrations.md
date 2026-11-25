# Optional integrations

v1.8.0 adds **14 optional MCP integration presets** on top of the five core presets
(`filesystem`, `fetch`, `github`, `git`, `sqlite`). Every integration is **disabled by default** —
nothing connects until you explicitly enable it. Each preset is a ready-made, secret-free
`mcp.servers` entry: it references `${ENV_VAR}` placeholders that are resolved from the environment
at connect time, never stored in the config.

## Managing integrations

- `mercury mcp presets` — list every preset with its provenance, npm package, required env vars and state.
- `mercury mcp enable <name> [--name myname] [--connect]` — write the preset into `mcp.servers` as **enabled**.
- `mercury mcp disable <name>` — set `enabled: false` and disconnect (the config entry is kept).
- `mercury mcp status` — show connected servers and which configured servers are enabled.

In the Web UI, the admin **Integrations** panel lists all presets with enable/disable buttons and a
warning when a required env var is unset.

Put secrets in `~/.mercury/.env` (e.g. `SLACK_BOT_TOKEN=…`). After enabling, restart Mercury (or
reconnect) so `connectAll` picks up the newly enabled server. `mercury mcp enable` reports any
required variable that is still unset.

## Provenance

- **official** — a currently maintained first-party server (MCP reference server still active, or a vendor's own server).
- **official-archived** — a first-party reference server that still publishes to npm but now lives in the MCP `servers-archived` repo. It works, but is no longer actively maintained upstream.
- **community** — a well-known third-party server. Verified to exist on npm, but not vendor-official; review it before trusting it with credentials.

Every package below was verified to resolve on npm (`npm view <pkg> version`). None is a fabricated
or placeholder name. All preset servers are registered as `untrusted`, so their output stays subject
to Mercury's taint tracking and approval policy.

## Catalog

| Integration | Preset name | Package | Provenance | Required env vars |
|---|---|---|---|---|
| Google Calendar | `google-calendar` | `@cocal/google-calendar-mcp` | community | `GOOGLE_OAUTH_CREDENTIALS` |
| CalDAV | `caldav` | `caldav-mcp` | community | `CALDAV_BASE_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD` |
| Slack | `slack` | `@modelcontextprotocol/server-slack` | official-archived | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| Playwright | `playwright` | `@playwright/mcp` | official | (none) |
| Puppeteer | `puppeteer` | `@modelcontextprotocol/server-puppeteer` | official-archived | (none) |
| Brave Search | `brave-search` | `@modelcontextprotocol/server-brave-search` | official-archived | `BRAVE_API_KEY` |
| Tavily | `tavily` | `tavily-mcp` | official | `TAVILY_API_KEY` |
| Redis | `redis` | `@modelcontextprotocol/server-redis` | official-archived | `REDIS_URL` |
| PostgreSQL | `postgres` | `@modelcontextprotocol/server-postgres` | official-archived | `POSTGRES_URL` |
| Discord | `discord` | `mcp-discord` | community | `DISCORD_TOKEN` |
| Microsoft Teams | `teams` | `@floriscornel/teams-mcp` | community | `TEAMS_MCP_CLIENT_ID`, `TEAMS_MCP_TENANT_ID` |
| Notion | `notion` | `@notionhq/notion-mcp-server` | official | `NOTION_TOKEN` |
| Confluence | `confluence` | `@aashari/mcp-server-atlassian-confluence` | community | `ATLASSIAN_SITE_NAME`, `ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN` |
| Obsidian | `obsidian` | `obsidian-mcp` | community | `OBSIDIAN_VAULT_PATH` |

## Example

```console
$ export SLACK_BOT_TOKEN=xoxb-… SLACK_TEAM_ID=T0123
$ mercury mcp enable slack
enabled preset 'slack' as mcp server 'slack'
$ mercury mcp status
$ mercury mcp disable slack
```

Integrations run through npx (Node packages) or uvx (the two Python core presets). Make sure the
relevant runner is installed. Live connectivity requires real credentials and is out of automated
test scope — the test suite verifies wiring only.
