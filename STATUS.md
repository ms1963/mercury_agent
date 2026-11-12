# Mercury — Build Status (honest snapshot)

**Overall: NOT finished.** The work ran out of its compute budget partway through.
`npm run build` / `npm test` / CLI / web UI do **not** work yet: the `runtime`, `server`
and `cli` packages are empty, and no tests exist.

## Compiles cleanly (`npx tsc -b packages/<name>`), not yet tested
| Package | Contents |
|---|---|
| `packages/core` | config (zod), event bus/tracer/metrics/recorder, SQLite db + FTS5 migrations, auth (scrypt, JWT, API tokens, RBAC policy, DM pairing), LLM providers (OpenAI-compatible, Anthropic, offline mock), router, budgets, Jev decision engine + judgment layer, tool registry/executor/approvals, plugins/hooks, memory (curated MEMORY.md/USER.md, facts, episodic, user model, vector embeddings), skills, checkpoints, attachments, voice, agent loop + patterns, guardrails, reflection, workflows (8 templates), scheduler (cron + natural language), scaffolding, help, i18n |
| `packages/tools` | 76 built-in tools, polyglot tool runner (tool.json), terminal backends (local/Docker/SSH), browser backends (fetch/Playwright), execute_code RPC sandbox |
| `packages/mcp` | MCP client manager (stdio/HTTP/SSE, sampling) and Mercury-as-MCP-server (stdio + streamable HTTP, scope checks) |
| `packages/gateway` | Adapter SDK, fetch + mock HTTP transports, 16 adapters (Telegram, Discord, Slack, WhatsApp, Signal, Email via minimal IMAP/SMTP, Matrix, Home Assistant, generic webhook, Mattermost, Teams, IRC, SMS/Twilio, RSS, web chat, CLI), adapter type registry |

None of the adapters has been run against a real service.

## Not done yet
1. `packages/gateway/src/gateway.ts`: pairing flow, session continuity, voice transcription, triage, approvals routing.
2. `packages/runtime`: composition root (`createMercury`) that wires everything together.
3. `packages/server`: Fastify REST API, SSE, webhooks, `/mcp`, `/metrics`, web UI SPA.
4. `packages/cli`: `mercury` command and REPL.
5. Assets: locales, help docs, bundled skills/workflows/polyglot examples, Docker/systemd/install.sh, CI, ESLint config, README, SECURITY.md, EXTENDING.md.
6. Vitest test suite.

`docs/ARCHITECTURE.md` describes the target design and how it lines up with Hermes features.
