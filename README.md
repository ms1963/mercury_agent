# ☿ Mercury

A self-hosted, extensible **agentic AI platform** in TypeScript: a CLI, a web UI, chat-platform
gateways, multi-agent workflows, persistent memory, skills, 75+ tools and MCP (client **and** server).
It aims for feature parity with Hermes Agent and adds a typed **decision engine (Jev)** that routes
models, judges risk, triages messages and drives reflection.

It runs **fully offline** with no API keys: a deterministic mock LLM, mock decision provider and
mock voice let you try every feature, and the test suite needs nothing external.

> Status: see [STATUS.md](STATUS.md) for what is tested and what has not been run against real
> external services.

## Quickstart

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
git clone <this repo> mercury && cd mercury
npm install && npm run build
node packages/cli/dist/bin.js chat "hello"     # one-shot chat with the mock model
node packages/cli/dist/bin.js serve            # web UI + API on http://localhost:3000
```

Or run `./install.sh` (builds and `npm link`s a global `mercury` binary), or use Docker:

```bash
docker compose up -d        # data persists in the mercury-data volume
```

Open the web UI. **The first account you register becomes admin.** To use a real model, set a key
and pick a model:

```bash
export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY
mercury model openai/gpt-4o-mini
export OPENROUTER_API_KEY=...       # also enables the Jev decision model (typesafe/jev-1.13)
```

`mercury setup` runs an interactive first-run wizard. `mercury doctor` checks the environment.
`mercury help <topic>` and the web **Help** panel document everything.

## Feature matrix

| Area | What you get |
|---|---|
| **Agent loop** | Streaming ReAct-style loop, patterns (react, plan-execute, reflexion…), subagents, `/stop`, `/retry`, `/undo`, `/compress`, `/rollback` |
| **LLM providers** | Mock (offline), OpenAI-compatible, Anthropic, OpenRouter; a model router with tiers; per-user/model token and cost **budgets** |
| **Decision engine** | `jev` (OpenRouter decisions API), `llm` or `mock` provider; used for model routing, injection classification, tool-approval “smart” mode, gateway triage, retries and reflection |
| **Memory** | Working, episodic (sessions + search), semantic facts, procedural (skills), user model, shared blackboard; `MEMORY.md` / `USER.md` |
| **Reflection** | Post-run lessons and user-model updates, viewable in the UI |
| **Skills** | agentskills.io `SKILL.md` format, bundled examples, install from path/git |
| **Tools** | 76 built-ins in toolsets (files, shell, web, code, memory, scheduling, data, utility…), **polyglot tools** in any language via `tool.json` |
| **MCP** | Client (stdio/HTTP servers become tools) and server (`/mcp` streamable HTTP with scoped tokens, or `mercury mcp serve` over stdio) |
| **Workflows** | YAML templates: single, pipeline, round-robin, coordinator-worker, tree, map-reduce, router, blackboard, debate |
| **Scheduler** | Natural-language (“every day at 9am”) or cron schedules that run agent tasks |
| **Gateway** | 16 adapters: Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Teams, IRC, Email, SMS, Home Assistant, RSS, webhook, webchat, CLI; DM pairing codes, cross-platform continuity, voice-memo transcription, triage to human review |
| **Voice** | STT/TTS providers: mock, OpenAI, local whisper / edge-tts / piper, or any command; mic recording and playback in the web UI |
| **Security** | scrypt + JWT, scoped API tokens, RBAC, layered prompt-injection guardrails, approvals, path jail, SSRF guard, secret redaction, hash-chained audit log; see [docs/SECURITY.md](docs/SECURITY.md) |
| **Observability** | Event traces for every run, live debug stream with breakpoints and pause/resume, `mercury replay`, Prometheus `/metrics` |
| **Web UI** | No-build SPA: chat with streaming, tool chips and approvals, attachments, sessions, runs, workflows, memory, skills, tools/MCP, scheduler, integrations, models/budgets, users, debug, reflections, help; dark/light; English/German |
| **Extensibility** | Plugins (tools, hooks, providers, patterns, templates, adapters), scaffolding via `mercury new …`; see [docs/EXTENDING.md](docs/EXTENDING.md) |

## Architecture

```mermaid
flowchart LR
  subgraph Frontends
    CLI[CLI / REPL]
    WEB[Web UI] -->|HTTP + SSE| SRV[HTTP server]
    CHAT[Chat platforms] --> GW[Gateway]
    MCPC[MCP clients] -->|/mcp| SRV
  end
  CLI --> RT
  SRV --> RT[Runtime: Mercury]
  GW --> RT
  SCH[Scheduler] --> RT
  RT --> AG[Agent loop + patterns]
  RT --> WF[Workflow engine] --> AG
  AG --> RTR[Model router + budgets] --> LLM[LLM providers]
  AG --> TX[Tool executor + guardrails] --> TOOLS[Built-in / polyglot / MCP tools]
  AG --> MEM[Memory + skills]
  AG --> REF[Reflection]
  RTR & TX & REF & GW --> DEC[Decision engine: Jev / LLM / mock]
  RT --> DB[(node:sqlite)]
```

Monorepo packages:

| Package | Role |
|---|---|
| `@mercury/core` | Config, DB, auth, LLM, decision engine, agent, memory, skills, workflows, scheduler, security |
| `@mercury/tools` | Built-in tools, terminal/browser backends, polyglot loader |
| `@mercury/mcp` | MCP client manager and Mercury MCP server |
| `@mercury/gateway` | Gateway controller and platform adapters |
| `@mercury/runtime` | Composition root (`createMercury()`) |
| `@mercury/server` | Fastify REST/SSE API, webhooks, `/mcp`, `/metrics`, static web UI |
| `@mercury/cli` | The `mercury` binary |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
npm run build      # tsc project references
npm test           # vitest (offline)
npx eslint .       # lint
```

Configuration lives in `$MERCURY_HOME/config.yaml` (default `~/.mercury`). Use
`mercury config get|set <key>` to manage it. Deployment files: `Dockerfile`, `docker-compose.yml`,
`deploy/mercury.service` (systemd), `install.sh`.

## License

MIT
