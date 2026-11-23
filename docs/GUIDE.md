![Mercury Agent](../assets/mercury_agent.png)

# ☿ Mercury — The Complete Guide

**For Users, Developers and Administrators.**

This is the full reference for installing, deploying, configuring, administrating, using, changing
and extending Mercury. It is written to be exhaustive: every CLI command, every configuration key,
every built-in tool, every HTTP endpoint and every extension point is covered here or in the linked
companion documents ([ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md),
[EXTENDING.md](EXTENDING.md), [PROVIDERS.md](PROVIDERS.md), [COMPARISON.md](COMPARISON.md), and the
topic files in [`docs/help/`](help/)).

> **How Mercury goes beyond the Hermes-parity baseline** — a self-evaluation harness (`mercury eval`),
> resilient provider calls (jittered exponential-backoff retries + fallback), and per-run token/cost
> accounting — is laid out, honestly scoped and tested-vs-untested, in [COMPARISON.md](COMPARISON.md).

> **Honest-status note.** Mercury's seven packages compile, `npm install && npm run build && npm test`
> passes **185/185 tests offline**, and the CLI, HTTP server and web UI run end-to-end with the
> deterministic offline mock LLM. **Nothing in this guide has been exercised against a real external
> service** — no real LLM API, no Jev API, no chat platform, no STT/TTS service, no Docker image
> build, no systemd run. Treat feature descriptions as "implemented and offline-tested"; see
> [STATUS.md](../STATUS.md) for the precise tested-vs-untested breakdown. Where a feature has only
> been run against a mock, this guide says so.
>
> **Mocks removed for integrations.** The integration-standing mocks have been stripped from the
> production/runtime paths: the gateway `MockTransport` (adapters now use the real `FetchTransport`;
> the test-only `MockTransport` moved to `tests/mock-transport.ts`), and the mock
> search/weather/image and STT/TTS branches. These subsystems now **require real configuration and
> fail explicitly** rather than silently falling back to a mock. The deterministic **mock LLM and mock
> decision provider remain available only** behind `MERCURY_ENABLE_MOCK=1` — the single sanctioned
> escape hatch the test suite depends on, never for production.

---

## How to use this guide

Read the part that matches your role; the parts are self-contained but cross-reference each other.

| If you are… | Start with | Then read |
|---|---|---|
| **A user** (chatting, using tools, skills, scheduler) | Part I (Install), Part V (Using) | Part VI (Tools), Appendix A (CLI), Appendix E (Troubleshooting) |
| **An administrator** (deploying, user management, security) | Part I–II, Part IV (Admin) | Part III (Config), Part X (Security), Appendix B (Config keys) |
| **A developer** (changing or extending Mercury) | Part VIII (Extending), Part XI (Architecture) | Part VII (Decisions), Part IX (Observability), Appendix C (HTTP API) |

### Table of contents

- **Part I — Installation**
- **Part II — Deployment**
- **Part III — Configuration**
- **Part IV — Administration**
- **Part V — Using Mercury**
- **Part VI — Tools reference**
- **Part VII — The decision engine (Jev)**
- **Part VIII — Changing & extending Mercury**
- **Part IX — Observability & debugging**
- **Part X — Security model**
- **Part XI — Architecture for developers**
- **Appendix A — Full CLI reference**
- **Appendix B — Full configuration key reference**
- **Appendix C — Full HTTP API reference**
- **Appendix D — Data directory layout**
- **Appendix E — Troubleshooting & `mercury doctor`**
- **Appendix F — Glossary**

---

## What Mercury is

Mercury is a **self-hosted, extensible agentic AI platform** written in TypeScript (Node.js 22+,
ESM, an npm-workspaces monorepo). In one process it provides:

- a **CLI** and interactive **REPL** (`mercury`),
- a **web UI** (a no-build single-page app) and a **REST + SSE HTTP API**,
- **chat-platform gateways** (19 adapters: Telegram, Discord, Slack, WhatsApp, Facebook, X, LinkedIn, Signal, Matrix,
  Mattermost, Teams, IRC, Email, SMS, Home Assistant, RSS, webhook, webchat, CLI),
- **multi-agent workflows**, **persistent memory**, **skills**, **79 built-in tools** plus
  polyglot (any-language) tools,
- an **MCP** client *and* server,
- a **scheduler**, **voice** (STT/TTS), and a full **security** stack (RBAC, API tokens, budgets,
  prompt-injection guardrails, path jail, SSRF guard, audit log).

It targets **feature parity with Hermes Agent** and adds a typed **decision engine (Jev)** that
routes models, classifies prompt-injection risk, gates tool approvals, triages inbound chat
messages and drives reflection. **Jev is entirely optional** — every decision degrades gracefully
to your configured LLM or to a built-in heuristic.

**Mercury has no built-in model.** Before it can answer anything you must point it at one real LLM
provider — ChatLLM/RouteLLM (Abacus.AI), OpenRouter, Ollama, LM Studio, Anthropic, or any
OpenAI-compatible endpoint (see Part III and [PROVIDERS.md](PROVIDERS.md)).

### The seven packages

| Package | Role |
|---|---|
| `@mercury/core` | Config, DB, auth, LLM, decision engine, agent, memory, skills, workflows, scheduler, security |
| `@mercury/tools` | Built-in tools, terminal/browser backends, polyglot loader, `execute_code` sandbox |
| `@mercury/mcp` | MCP client manager and Mercury-as-MCP-server |
| `@mercury/gateway` | Gateway controller and the 19 platform adapters |
| `@mercury/runtime` | Composition root — `createMercury()` wires every service together |
| `@mercury/server` | Fastify REST/SSE API, webhooks, `/mcp`, `/metrics`, static web UI |
| `@mercury/cli` | The `mercury` binary (REPL, subcommands, scaffolding) |

Dependency direction: `cli, server → runtime → {tools, mcp, gateway} → core`. `core` depends only
on `zod`, `yaml` and Node built-ins (including `node:sqlite`).


---

# Part I — Installation

## 1.1 Requirements

- **Node.js ≥ 22.5.0.** Mercury uses the built-in `node:sqlite` module, which only exists from
  Node 22.5. Check with `node -v`. (`node:sqlite` is still marked *experimental* in Node 22; Mercury
  works with it but you will see an experimental-feature warning on start — this is expected.)
- **npm** (bundled with Node). `git` to clone. A POSIX shell for `install.sh`.
- Roughly 500 MB of disk for `node_modules` and the build output; the runtime footprint is small.
- **Optional at install time, required to actually answer:** one LLM provider (cloud key or a local
  Ollama/LM Studio). You can install first and configure the provider afterwards.
- **No database server needed** — Mercury stores everything in a single SQLite file in its data
  directory.

## 1.2 Install from source (recommended)

```bash
git clone <this repo> mercury && cd mercury
npm install          # installs workspace deps for all 7 packages
npm run build        # tsc project references → each package's dist/
```

`npm run build` runs `tsc -b packages/cli packages/server`, which transitively builds every package
via TypeScript project references. After it finishes you can run the binary directly:

```bash
node packages/cli/dist/bin.js version      # → "mercury 1.4.0"
node packages/cli/dist/bin.js doctor       # environment check (see Appendix E)
```

> **esbuild postinstall warning.** The root `package.json` now pre-approves esbuild's postinstall
> script (`"allowScripts": { "esbuild": true }`), so clean installs are silent on npm versions that
> gate build scripts. On older npm you may still see a one-line "script was not approved" notice — it
> is harmless; the build and tests run regardless.

## 1.3 Install the global `mercury` binary

`install.sh` builds the project and `npm link`s a global `mercury` command so you can type
`mercury …` from anywhere instead of `node packages/cli/dist/bin.js …`:

```bash
./install.sh
mercury version
```

> **Status:** `install.sh` is provided but has **not been run in the test environment**. If `npm link`
> fails for permissions reasons on your system, either run it with appropriate privileges or keep
> using `node packages/cli/dist/bin.js`. Throughout this guide, `mercury <cmd>` and
> `node packages/cli/dist/bin.js <cmd>` are interchangeable.

## 1.4 Install with Docker

```bash
docker compose up -d        # builds the image and runs the server; data persists in the mercury-data volume
```

The repository ships a `Dockerfile` and a `docker-compose.yml` (which declares a named volume
`mercury-data` mounted at the data directory). See Part II for details.

**Offline voice in the container.** The default image is slim and does **not** bundle the offline
voice engines. For in-container offline STT/TTS, build the voice-enabled image — it ships `ffmpeg`,
`whisper` and `piper` (larger, as it includes CPU PyTorch):

```bash
docker compose --profile voice up -d --build mercury-voice   # or: docker build -f Dockerfile.voice -t mercury-agent:voice .
```

## 1.5 First-run setup

Mercury needs (a) an admin account and (b) one LLM provider before it can answer. Two ways:

**Interactive wizard:**

```bash
mercury setup
```

This prompts for an admin username and password and walks you through selecting and wiring an LLM
provider. Run `mercury doctor` afterwards to confirm the environment.

**Non-interactive (scripts, CI, containers):**

```bash
mercury setup --username admin --password '<pw>' --provider ollama --model ollama/llama3.1
```

Alternatively, start the server and register the first account through the web UI — **the first
account that registers automatically becomes the admin** (see Part IV).

Configure at least one provider before chatting. The quickest paths (full matrix in Part III and
[PROVIDERS.md](PROVIDERS.md)):

```bash
# Local, no API key — run Ollama or LM Studio first, then:
mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
mercury model ollama/llama3.1

# Or a cloud key in the data-dir .env:
echo 'CHATLLM_API_KEY=s2-...'     >> ~/.mercury/.env   # Abacus.AI ChatLLM / RouteLLM
mercury model chatllm/route-llm
# …or OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
```

Copy the documented starting templates if you want them:
[`.env.example`](../.env.example) → `~/.mercury/.env`, and
[`mercury.example.yaml`](../mercury.example.yaml) → `~/.mercury/config.yaml`.

## 1.6 Verify the installation

```bash
mercury doctor                               # checks Node version, data dir, config, providers, keys
MERCURY_ENABLE_MOCK=1 mercury chat "hello"   # offline smoke test (no provider needed) → "Echo: hello"
npm test                                     # run the vitest suite (185 tests, offline)
```

The mock provider is **disabled in normal operation**; it is enabled only when
`MERCURY_ENABLE_MOCK=1` is set, and is meant for offline development and the test suite — not for
real use.


---

# Part II — Deployment

Mercury is a **single process** backed by a SQLite file. There is no separate database, cache or
queue to run. Deployment is therefore "run one Node process, keep it alive, and (optionally) put TLS
in front of it".

## 2.1 Running the server

```bash
mercury serve                 # defaults to host 0.0.0.0, port 3000
mercury serve --port 8080
```

`mercury serve` starts **everything** in one process: the HTTP REST/SSE API, the static web UI, the
**scheduler**, the **gateway** (if enabled in config), and the **MCP endpoint** at `/mcp`. Open
`http://<host>:3000` for the web UI; the API lives under `/api` (Appendix C).

Bind address and port come from `server.host` / `server.port` (overridable with `--port`). To
advertise an external URL (used for building absolute links, webhooks, etc.) set `server.publicUrl`.

## 2.2 Environment variables

| Variable | Effect |
|---|---|
| `MERCURY_HOME` | Overrides the data directory (default `~/.mercury`). Everything — DB, config, secrets, attachments, extensions — lives here. |
| `MERCURY_ENABLE_MOCK=1` | Enables the deterministic mock LLM/decision providers. **Never set this in production.** |
| `OPENAI_API_KEY` | Auto-enables the `openai` provider and is read by it. |
| `ANTHROPIC_API_KEY` | Auto-enables the `anthropic` provider. |
| `OPENROUTER_API_KEY` | Auto-enables the `openrouter` provider **and** the optional Jev decision model. |
| `CHATLLM_API_KEY` / `ABACUS_API_KEY` | Auto-enables the `chatllm` (Abacus.AI RouteLLM) provider. |
| any `apiKeyEnv` you name | For `openai-compatible` providers, the env var you set as `apiKeyEnv` holds that endpoint's key. |

API keys belong in `$MERCURY_HOME/.env` or the process environment — **never in `config.yaml`**
(which may be shared or committed). Log verbosity is controlled by the `logLevel` config key
(`debug|info|warn|error|silent`) or the `debug` flag.

## 2.3 systemd (Linux hosts)

The repo ships a hardened unit at [`deploy/mercury.service`](../deploy/mercury.service). The standard
pattern (adapt paths to your install):

```ini
[Unit]
Description=Mercury agent server
After=network-online.target
Wants=network-online.target

[Service]
User=mercury
WorkingDirectory=/opt/mercury
Environment=MERCURY_HOME=/var/lib/mercury
ExecStart=/usr/bin/node /opt/mercury/packages/cli/dist/bin.js serve
Restart=on-failure
RestartSec=3
# hardening (see the shipped unit for the full set): NoNewPrivileges, ProtectSystem=strict,
# ProtectHome, PrivateTmp, a writable path only for the data dir, etc.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mercury
journalctl -u mercury -f           # logs
```

> **Status:** `deploy/mercury.service` has **not been run** in the test environment; it is provided
> as a hardened starting point.

## 2.4 Docker / Compose

```bash
docker compose up -d          # build + run; persists the data dir in the mercury-data volume
docker compose logs -f
docker compose down           # stop (the volume — your data — survives)
```

The `Dockerfile` builds all packages and runs `serve`; `docker-compose.yml` mounts a named volume
`mercury-data` at the data directory so your DB, config and secrets persist across container
restarts. Pass provider keys via the compose `environment:` block or an `env_file:` — do not bake
them into the image. For offline voice inside the container, build the voice-enabled image
(`Dockerfile.voice`, compose profile `voice`) as shown in §1.4; it adds `ffmpeg` + `whisper` +
`piper` and keeps whisper's model cache on the `mercury-data` volume.

## 2.5 Reverse proxy & TLS

Put Mercury behind a reverse proxy (nginx, Caddy, Traefik) terminating TLS whenever it is reachable
from a network. Requirements:

- **Proxy the upstream on its bound port** (default 3000).
- **Allow Server-Sent Events** — `/api/chat` (streaming), `/api/runs/:id/events`, `/api/events` and
  the debug stream are long-lived SSE responses. Disable proxy buffering for them
  (`proxy_buffering off;` in nginx) and allow long read timeouts.
- **Forward the `Host`/`X-Forwarded-Proto` headers** and set `server.publicUrl` to the external URL.
- The webhook endpoints (`/webhooks/:name`) must be reachable by the chat platforms that call them
  (Slack, generic webhook adapter, etc.); Telegram uses long polling and needs no inbound route.

A minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;          # required for SSE streaming
    proxy_read_timeout 3600s;
}
```

## 2.6 Rate limiting & body size

Mercury has a built-in **SQLite-backed** per-client fixed-window rate limiter: `server.rateLimit`
(default 300 requests / 60 000 ms). Counters live in the same `mercury.db` (a `rate_limits` table),
so they survive restarts and are shared across all requests in the process. Request bodies are capped at `server.maxBodyBytes` (default
30 MB); uploaded attachments are capped separately at `attachments.maxBytes` (default 25 MB).

## 2.7 Scaling limits (read before you deploy at scale)

Per [STATUS.md](../STATUS.md), the current architecture is deliberately single-node:

- **Single process + SQLite** (`node:sqlite`, still experimental in Node 22). **No horizontal
  scaling** — do not run multiple instances against the same DB file.
- **The rate limiter is SQLite-backed** (persistent, shared across the process), but it is still
  **single-host** — its counters are not shared across replicas. Cross-host limiting needs an
  external store (Redis/Postgres).
- Suitable for a team / personal / single-host deployment. For higher load, scale **up** (a bigger
  host) rather than out, and keep the data directory on fast local storage.

## 2.8 Backups

Back up the **entire data directory** (`$MERCURY_HOME`, default `~/.mercury`) — it contains the
SQLite database (`mercury.db`), the JWT signing key (`secret.key`), user memory files, attachments
and all your extensions. A consistent snapshot while the server is stopped is simplest; for a live
backup, copy `mercury.db` with a SQLite-aware tool. See Appendix D for the full layout.


---

# Part III — Configuration

## 3.1 How configuration is layered

Configuration is resolved from four sources, **lowest priority first**:

```
built-in defaults  <  config file (config.yaml)  <  environment variables  <  CLI flags
```

Every key has a sensible default (defined by the zod schema in
`packages/core/src/config/schema.ts`), so an **empty config file yields a working setup** once one
LLM provider is configured. You only ever need to set the keys you want to change.

- **Config file:** `$MERCURY_HOME/config.yaml` (default `~/.mercury/config.yaml`). YAML or JSON.
- **Secrets:** `$MERCURY_HOME/.env` (API keys only — never put keys in `config.yaml`).
- **Environment:** process env overrides the file (notably the provider `*_API_KEY` vars).
- **CLI flags:** e.g. `--model`, `--port` override everything for that invocation.

## 3.2 Managing config from the CLI

```bash
mercury config path                 # print the resolved config file path
mercury config get llm.defaultModel # read one key (dotted path)
mercury config get                  # dump the whole resolved config
mercury config set agent.pattern plan-execute
mercury config set server.port 8080
# Nested objects take a JSON value:
mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
mercury config set budgets.rules '[{"user":"*","period":"daily","maxTokens":500000}]'
```

Keys are dotted paths into the schema. Object/array values are passed as JSON strings. You can also
edit `config.yaml` directly and restart. Some files (`mcp.json`) hot-reload without a restart.

## 3.3 Configuration sections at a glance

The complete, every-key-with-default reference is **Appendix B**. The top-level sections are:

| Section | Purpose |
|---|---|
| top-level | `dataDir`, `locale` (`en`/`de`), `logLevel`, `debug` |
| `server` | host, port, publicUrl, rate limit, max body size |
| `auth` | token TTL, open-registration toggle |
| `llm` | providers, model profiles, default model, retries, timeout |
| `router` | model-routing weights, rules, fallback chain, use-of-decisions, top-k |
| `budgets` | per user × model × period token/cost limits, admin bypass |
| `decision` | Jev engine: provider mode, Jev endpoint, thresholds, which decisions it drives |
| `agent` | pattern, iteration/subagent/depth limits, personality, temperature, compression |
| `memory` | char limits, recall-k, embeddings provider |
| `skills` | skill dirs, auto-create, min tool-calls to form a skill |
| `reflection` | post-run lessons, user-model updates |
| `tools` | disabled tools/toolsets, per-platform toolsets, approvals, path jail, terminal/web/browser/image backends, execute_code limits |
| `mcp` | external MCP servers (client) and the built-in MCP server endpoint |
| `gateway` | enable, continuity, pairing, triage, per-platform adapters |
| `scheduler` | enable, tick interval, max retries |
| `attachments` | max size, allowed kinds, optional AV scan command |
| `voice` | STT/TTS/wake-word providers |
| `security` | injection toggles, secret/PII redaction, audit |
| `observability` | event recording, OTLP endpoint, Prometheus metrics |
| `wiki` | LLM Wiki — enable, directory, schema file, stub threshold |
| `addins` | declarative Add-In discovery — enable, directory |
| `permissions` | per-agent/personality permission-profile directory |
| `plugins`, `hooks` | plugin module list, event hooks (log/webhook) |

## 3.4 Configuring LLM providers

Model ids are always `"<provider>/<model>"`. Set the active model with `mercury model <id>`, the
`llm.defaultModel` key, or `/model` in chat. Leaving `llm.defaultModel: auto` lets the router pick
among every configured provider.

Supported provider `type`s: `openai`, `anthropic`, `openrouter`, `chatllm`, `ollama`, `lmstudio`,
`openai-compatible`, and `mock` (gated behind `MERCURY_ENABLE_MOCK=1`).

**Auto-enabling by environment key** — set the key in `~/.mercury/.env` and the provider needs no
config entry at all:

| Env key | Provider auto-enabled | Example model id |
|---|---|---|
| `CHATLLM_API_KEY` / `ABACUS_API_KEY` | `chatllm` (Abacus.AI RouteLLM) | `chatllm/route-llm`, `chatllm/gpt-4o-mini`, `chatllm/claude-sonnet-4-5` |
| `OPENROUTER_API_KEY` | `openrouter` (+ optional Jev) | `openrouter/openai/gpt-4o-mini` |
| `OPENAI_API_KEY` | `openai` | `openai/gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | `anthropic` | `anthropic/claude-sonnet-4-5` |

**Local providers** (no key): run Ollama (`http://localhost:11434/v1`) or LM Studio
(`http://localhost:1234/v1`), enable them in config, and use `ollama/<model>` / `lmstudio/<model>`.

**Any OpenAI-compatible endpoint** (vLLM, LocalAI, Together, Groq, Azure OpenAI, …):

```bash
mercury config set llm.providers.myapi '{"type":"openai-compatible","baseUrl":"https://host/v1","apiKeyEnv":"MYAPI_KEY","enabled":true}'
echo 'MYAPI_KEY=...' >> ~/.mercury/.env
mercury model myapi/<model>
```

`apiKeyEnv` names the env var holding the key (preferred over an inline `apiKey`); `headers` adds any
extra headers; `baseUrl` points at the endpoint. Full per-provider recipes, including Anthropic-
compatible gateways and ChatLLM base-URL overrides, are in [PROVIDERS.md](PROVIDERS.md).

### Model profiles and the router

Optionally declare `llm.models[]` profiles so the **router** can filter by capability and score by
cost/latency/quality. Each profile carries: `id`, `tags[]`, `quality` (0–1), `costPer1MInput/Output`,
`latencyMs`, `contextWindow`, capability flags (`tools`, `vision`, `audio`, `json`) and `enabled`.
The router resolves a model as: **explicit model > `router.rules` (regex/tags) > capability filter >
weighted score (`router.weights`) > optional Jev choice among top-k > `router.fallback` chain on
error**. Turn routing off with `router.enabled: false` to always use `llm.defaultModel`.

## 3.5 Secrets & `.env`

Put all API keys in `$MERCURY_HOME/.env` (or the process environment). Never in `config.yaml`.
Keep the data directory private — it also holds `secret.key` (the JWT signing key) and the database.
Secrets are redacted from logs and tool output by default (`security.redactSecrets: true`).


---

# Part IV — Administration

This part is for the person who runs the Mercury instance. See Part X for the full security model.

## 4.1 Users & roles (RBAC)

- **The first registered account becomes `admin`;** every later sign-up is a `user`.
- Each user's sessions, memory and runs are **scoped to that user**. Admin-only capabilities (user
  management, config changes, gateway pairing, audit log, viewing all insights) are enforced per
  route and per command.

CLI user management (admin):

```bash
mercury user list
mercury user add <username>           # create a user
mercury user passwd <username>        # reset a password
mercury user role <username> admin    # promote/demote (admin | user)
mercury user delete <username>
```

The same actions exist in the web **Users** panel.

## 4.2 Lock down registration

After you have created the admin (and any other accounts), close open sign-ups:

```bash
mercury config set auth.allowRegistration false
```

New users then can only be created by an admin.

## 4.3 API tokens & scopes

Prefer scoped, expiring **API tokens** over admin JWTs for integrations (CI, scripts, MCP clients).
Tokens are `mrc_…` strings, stored only as SHA-256 hashes, with optional expiry and scopes.

```bash
mercury token list
mercury token create ci --scopes chat,mcp      # prints the token ONCE — copy it now
mercury token revoke <id>
```

Available scopes: `chat, agent, workflow, memory, skills, tools, schedule, mcp, admin, read, *`.
The `/mcp` endpoint requires a token with the `mcp` scope, and each MCP tool additionally requires
its matching scope (`agent`, `workflow`, `memory`, `skills`, `schedule`); built-in tools are exposed
over MCP as `mercury_<name>` only when the token has the `tools` scope.

Session JWTs are HS256, signed with the random key in `$MERCURY_HOME/secret.key`, lifetime
`auth.tokenTtlHours` (default 168 hours = 7 days).

## 4.4 Token & cost budgets

Stop runaway loops and cap spend with **budgets** — per `user × model × period` limits on tokens
and/or cost, checked before (estimate) and after (actual) each LLM call.

```bash
# everyone, all models, 500k tokens/day:
mercury config set budgets.rules '[{"user":"*","model":"*","period":"daily","maxTokens":500000}]'
```

Each rule: `user` (id or `*`), `model` (id or `*`), `period` (`daily`|`monthly`), `maxTokens?`,
`maxCost?`. `budgets.enabled` toggles the whole system; `budgets.adminBypass` (default true) lets
admins past the limits. Budgets are also manageable via the web **Models/Budgets** panel and the
`/api/budgets` routes.

## 4.5 Tool approvals, path jail & SSRF (operational knobs)

- **Approvals mode** `tools.approvals.mode`: `manual` (default — every sensitive call waits for a
  human), `smart` (the decision engine auto-approves low-risk calls above the confidence threshold),
  `auto` (approve all — only for fully trusted environments), `deny` (block all sensitive calls).
  Approve/deny from chat (`/approve <id>`, `/deny <id>`, `/approvals`), the web UI, or `/api/approvals`.
- **Path jail** `tools.jail.roots`: confines file tools to the listed roots plus the workspace. Set
  `tools.jail.allowOutside: true` to disable (not recommended).
- **SSRF guard**: web tools block private/loopback/link-local addresses unless
  `tools.web.allowPrivateNetworks: true`, and cap response size at `tools.web.maxBytes`.
- **Terminal isolation**: `tools.terminal.backend` = `local` (default, runs as the Mercury OS user),
  `docker` (isolated, image `tools.terminal.dockerImage`), or `ssh` (to a configured host).

Keep approvals on `manual` whenever the agent can read untrusted content and act on it.

## 4.6 The gateway (chat platforms)

Enable the gateway and configure adapters, then manage pairing:

```bash
mercury gateway status           # adapters + pending pairings
mercury gateway start            # start adapters (or just run `mercury serve` with gateway.enabled)
mercury gateway pending          # list pairing codes awaiting approval
mercury gateway pair <CODE>      # approve a pairing code → links that chat identity to a user
```

Unknown chat users get a **pairing code**; nothing reaches the agent until an admin approves it.
Messages from paired users then run with that user's permissions. Optional **triage**
(`gateway.triage: true`) routes low-confidence inbound messages to a human-review queue. Continuity
is per-user across platforms by default (`gateway.continuity: per-user` | `per-chat`). The 16
adapters and their config live under `gateway.adapters.<name>`.

## 4.7 Audit log

The audit log is **append-only and hash-chained** (each entry carries the previous entry's hash; SQL
triggers forbid UPDATE/DELETE, and `verify()` detects tampering). View it in the web **audit** view,
via `GET /api/audit` (admin), or with `mercury audit list` / `mercury audit verify` (Appendix A).

> **Scope:** it records user **registration**, **updates** (role changes) and **deletion**
> (`user.register` / `user.update` / `user.delete`), **config changes**, successful and failed
> **logins** (`auth.login` / `auth.login_failed`, the failure tagged with a reason of `unknown_user`,
> `bad_password` or `account_disabled` — the attempted password is never stored), API **token**
> issuance and revocation (`token.issue` / `token.revoke`), and gateway **pairing** approvals and
> rejections (`pairing.approve` / `pairing.reject`). These events are recorded at the service layer,
> so they are captured whether the action arrives over the HTTP API or the CLI. Guardrail verdicts and
> every tool/LLM/decision call additionally appear in per-run event traces (Part IX).

**Querying.** `GET /api/audit` accepts optional `actor`, `action`, `target`, `since`, `until`,
`limit` and `offset` query parameters and returns `{ entries, total, integrity }`. The `action`
filter matches either an exact value or a dotted prefix, so `?action=token` returns both
`token.issue` and `token.revoke`. The same filters are available on the CLI, e.g.
`mercury audit list --action auth.login_failed --since 2026-11-01 --limit 50 --json`.

## 4.8 Data-directory security & backups

- Keep `$MERCURY_HOME` readable only by the Mercury user — it holds `mercury.db`, `secret.key`
  (0600), attachments and all extensions.
- Run under Docker or the hardened systemd unit, **not as root**.
- Put TLS in front of the server whenever it is network-reachable.
- Back up the whole data directory (see §2.8 and Appendix D).

## 4.9 Updating Mercury

```bash
mercury update        # git pull + npm install + npm run build
```

> **Status:** `mercury update` has **not been run** against a real upstream in the test environment.
> The manual equivalent is `git pull && npm install && npm run build`, then restart the service.


---

# Part V — Using Mercury

## 5.1 Chatting from the CLI & REPL

```bash
mercury chat "Summarise the latest release notes"     # one-shot
mercury chat                                           # no message → interactive REPL
```

`chat` flags: `--model <id>` (override the model for this turn), `--session <id>` (continue a
specific session), `--pattern <name>` (force a reasoning pattern), `--user <id>` (act as a user).
In the REPL, type messages; lines beginning with `/` are **slash commands** (below), and `/exit` or
`/quit` leave the REPL.

The mock provider only responds to explicit `call:<tool> {json}` syntax (e.g.
`chat 'call:calculator {"expression":"6*7"}'` → `42`); real conversational quality comes from the
configured LLM.

## 5.2 The web UI

`mercury serve`, then open `http://<host>:3000`. The UI is a no-build single-page app with **15
panels**: Chat (streaming, markdown, tool chips, inline approvals, usage, feedback), Sessions, Runs,
Workflows, Memory, Skills, Tools/MCP, Scheduler, Integrations (gateway), Models/Budgets, Users
(admin), Debug, Reflections, Help, and Settings. It supports **dark/light** themes and **English /
German** locales. Register the first account to become admin; configure a provider; start chatting.

## 5.3 Slash commands (CLI, web and gateway)

Slash commands are implemented once (`core/src/agent/commands.ts`) and work the same everywhere:

| Command | Effect |
|---|---|
| `/help [topic]` | Help overview or a specific topic |
| `/new`, `/reset` | Start a fresh session / clear the current one |
| `/model [id\|auto]` | Show or switch the model for this session |
| `/pattern [name\|auto]` | Show or switch the reasoning pattern |
| `/personality [name]` | Switch the active personality |
| `/retry` | Re-run the last turn |
| `/undo` | Undo the last exchange |
| `/stop` | Abort the running agent |
| `/compress` | Compress the working context now |
| `/usage` | Token/cost usage for the session |
| `/insights [days]` | Usage insights (admin may append `all` for everyone) |
| `/skills [name]` | List skills, or view one |
| `/<skill-name>` | Invoke a skill directly |
| `/rollback [checkpoint-id]` | Roll the filesystem back to a checkpoint |
| `/approve <id>`, `/deny <id>`, `/approvals` | Tool-approval queue |
| `/memory [query]` | Show or search your memory |
| `/feedback good\|bad` | Rate the last run (feeds reflection) |
| `/debug on\|off\|llm\|tool\|list\|resume <id>\|skip <id>` | Live debugging & breakpoints |
| `/tools` | List available tools |
| `/sessions [query]` | List or search sessions |
| `/exit`, `/quit` | Leave the REPL (REPL only) |

## 5.4 Sessions, attachments & references

- **Sessions** persist every conversation (SQLite + FTS5 full-text search). Continue one with
  `--session <id>` or `/sessions`; search with `/sessions <query>`.
- **Attachments**: upload images, audio, video, documents (web UI, or `POST /api/attachments`). Capped
  at `attachments.maxBytes` (25 MB). Providers degrade gracefully — audio → transcript, video →
  frames/transcript, image → description — when the model lacks that capability.
- **Inline references** in a message are expanded before the turn: `@file <path>`, `@folder <path>`,
  `@diff` (working git diff), `@url <url>`. References honour the path jail and SSRF guard, and their
  contents are tagged **untrusted**.
- **Context files**: Mercury auto-loads project context from `AGENTS.md`, `CLAUDE.md`, `SOUL.md`,
  `.cursorrules` and similar files in the working directory, folding them into the system prompt.

## 5.5 Memory

Mercury keeps several kinds of memory, all scoped per user:

- **Curated** `MEMORY.md` (facts the agent should always know) and `USER.md` (what it has learned
  about you) — bounded by `memory.memoryCharLimit` (2200) and `memory.userCharLimit` (1375). View and
  edit via `/memory`, the web Memory panel, or `PUT /api/memory/curated/:which`.
- **Semantic facts** (remember/recall/forget) with FTS5 + a vector index; embeddings provider is
  `memory.embeddings.provider` (`hash` default, or `openai`/`ollama`).
- **Episodic** sessions + search; **procedural** = skills; a **user model** (traits inferred with
  confidence); and a workflow **blackboard**.

## 5.6 Skills

Skills are reusable procedures in agentskills.io `SKILL.md` format (frontmatter: `name`,
`description`, optional `license`, `compatibility`, `allowed-tools`, `metadata`). Only the index
(name + description) is in the prompt; the agent loads full content on demand (`skill_view`).

```bash
mercury skills list
mercury skills view <name>
mercury skills install <path|git-url>     # install from a folder or git repo
```

Invoke a skill in chat with `/<skill-name>`. Mercury can also **create skills autonomously** via
reflection (after `skills.minToolCallsForSkill` tool calls, when `skills.autoCreate` is on) and refine
them with success statistics. Write your own: see Part VIII and [EXTENDING.md](EXTENDING.md).

**Skill composition (1.1.1).** The `SkillComposer` and the `skill_compose` tool (toolset `skills`, risk
`moderate`) let a skill build on other skills — one skill can reference and run another, with the
results composed into a single procedure. Composition is bounded by `composition.maxDepth` and
`composition.maxSteps` and cached (`composition.cache`) to avoid recomputation. It is **on by default**
(`composition.enabled: true`); when disabled the `skill_compose` tool returns an error rather than
running. See Appendix B.

## 5.7 Scheduler

Run agent tasks on a schedule (natural language, cron, intervals or one-shot):

```bash
mercury schedule list
mercury schedule add --when "every day at 9am" "Summarise overnight news and email me"
mercury schedule edit <id> --when "every 3 hours" --name "News" --task "..."   # change time/name/task
mercury schedule pause <id>
mercury schedule resume <id>
mercury schedule run <id>            # run now
mercury schedule delete <id>
```

Schedules can run agents or workflows, carry attached skills, and deliver results to gateway targets.
The scheduler ticks every `scheduler.tickMs` (30 s), retries up to `scheduler.maxRetries`, and keeps
per-schedule history. Manage it in the web Scheduler panel (each row has **Edit** / Run now / History /
pause / delete controls) or via `/api/schedules` (`PATCH /api/schedules/:id` edits one).

## 5.8 Workflows (multi-agent)

Templates: `single`, `pipeline`, `round-robin`, `coordinator-worker`, `tree`, `map-reduce`,
`router`, `blackboard`, `debate`, `planner-executor`. A workflow spec (YAML/JSON) names the template,
its agents (role, model, toolsets, pattern) and budgets.

```bash
mercury workflow list
mercury workflow run debate "Remote work is better than office work"
```

Also runnable from the web UI or the `run_workflow` tool/MCP tool. `type: auto` lets the decision
engine pick a template. Authoring workflows: Part VIII.

**`planner-executor` — for work that was finishing too early (1.1.1).** When a run ends after one or
two steps even though the goal needs more, use `planner-executor`: a **planner** makes one structured
call to decompose the goal into several concrete steps, an **executor** runs each step in order
(feeding earlier results forward), re-planning once on a failed step instead of stopping, and an
optional **synthesizer** writes the final combined answer. Every step emits a `workflow.step` event so
progress is observable, and the `maxSteps` cap plus the usual run budgets prevent runaway loops.

```yaml
name: deep-dive
type: planner-executor
options:
  minSteps: 3      # always run at least this many steps
  targetSteps: 5   # how many steps the planner aims for
  maxSteps: 12     # hard cap (never exceeded)
  replanOnFailure: true
agents:
  - name: planner      # optional; produces the ordered step list
    role: Break the goal into clear, ordered steps.
  - name: executor     # runs each step (falls back to the first non-planner agent)
    role: Carry out one step at a time.
  - name: synthesizer  # optional; combines the step results
    role: Combine the step results into a complete answer.
```

Defaults come from `workflows.planner` in config — `enabled` is **off by default** for the automatic
pattern, but the template itself is always available by name; `options` on the spec override the
config defaults. See Appendix B and the [`workflows` help](help/workflows.md).

## 5.9 MCP (Model Context Protocol)

Mercury is **both** an MCP client and an MCP server. The Model Context Protocol is a standard that lets
AI apps talk to external "tool servers" — a filesystem server, a GitHub server, a database server, a
Slack server, and hundreds of community servers. By connecting Mercury to one, **every tool that server
offers becomes a tool your Mercury agent can call**, exactly like a built-in tool.

### 5.9.1 Connecting Mercury to an external MCP server (Mercury as client)

When you connect a server, its tools are discovered automatically and registered under the name
`mcp_<server>_<tool>`, grouped into the toolset `mcp:<server>`. (So a `read_file` tool on a server you
named `fs` becomes `mcp_fs_read_file`.)

**Three transports are supported** — pick the one the server documents:

| Transport | Use when the server… | Required fields |
|---|---|---|
| `stdio` | is a local program/command you run (the most common kind — e.g. an `npx` package) | `command`, optional `args`, `env` |
| `http` | is a remote Streamable-HTTP endpoint | `url`, optional `headers` |
| `sse` | is a remote Server-Sent-Events endpoint | `url`, optional `headers` |

**The simplest way to add one — edit `~/.mercury/mcp.json`.** This file **hot-reloads**, so changes take
effect without restarting Mercury. It is a map of server name → config. Example connecting three servers:

```jsonc
{
  // A) A local stdio server launched via npx (filesystem access, scoped to one folder)
  "fs": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/projects"],
    "trust": "untrusted"
  },

  // B) A local stdio server that needs a secret, passed via env
  "github": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
  },

  // C) A remote Streamable-HTTP server behind an auth header
  "weather": {
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer YOUR_TOKEN" },
    "include": ["get_forecast", "get_alerts"],   // only expose these tools
    "trust": "untrusted"
  }
}
```

**Per-server options** (all optional unless noted):

| Field | Meaning |
|---|---|
| `transport` | `stdio`, `http`, or `sse` (**required**). |
| `command`, `args`, `env` | For `stdio`: the program to run, its arguments, and environment variables (good place for the server's API key). |
| `url`, `headers` | For `http`/`sse`: the endpoint and any auth headers. |
| `include` / `exclude` | Glob lists to allow/deny specific tool names from that server (useful to hide dangerous ones). |
| `trust` | `untrusted` (default) or `trusted`. Untrusted servers' output is **spotlighted** (treated as data, not instructions) to resist prompt-injection — leave it `untrusted` unless you fully control the server. |
| `allowSampling` | `false` by default. If `true`, the server may ask **your** LLM for completions. Enable only for servers you trust. |
| `enabled` | Set `false` to keep a definition but turn it off. |

**Other ways to add a server** (equivalent — use whichever fits):

```bash
# From the CLI config (writes into config.yaml under mcp.servers):
mercury config set mcp.servers.fs '{"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/home/me"]}'

# Or from the web UI: Settings → Tools/MCP → add a server.
# Or via the HTTP API: POST /api/mcp  (admin; see Appendix C).
```

**Curated presets — the shortcut for well-known servers (1.1.1).** Rather than hand-write the config for
a common connector, enable a shipped preset. The presets are `filesystem`, `fetch`, `github`, `git` and
`sqlite`; all are registered `untrusted` (their output stays subject to spotlighting/policy/approval) and
none embed secrets — they reference `${ENV_VAR}` placeholders (`MCP_FS_ROOT`, `GITHUB_TOKEN`,
`MCP_GIT_REPO`, `MCP_SQLITE_DB`; `fetch` needs none) resolved from the environment at connect time.

```bash
mercury mcp presets                 # list presets and the env vars each one needs
mercury mcp status                  # configured servers + whether each is connected (default sub-command)
mercury mcp enable github --name gh # write the preset into mcp.servers (optionally under a custom name)
mercury mcp enable github --connect # enable and connect immediately
```

`mercury mcp enable` reports any required variables that are unset so you can export them before
connecting. See the [`mcp` help](help/mcp.md).

**Check it worked and use the tools:**

```bash
mercury mcp list          # shows each server: transport, connected?, and the tools discovered
mercury tools list        # the server's tools now appear as mcp_<server>_<tool>
mercury chat "Use the filesystem tools to list the files in my projects folder"
```

The agent will call the newly available `mcp_*` tools on its own. If a server fails to connect,
`mercury mcp list` shows the error (common causes: wrong `command`/`url`, a missing key in `env`, or the
server package not installed).

### 5.9.2 Exposing Mercury's own tools over MCP (Mercury as server)

Other MCP-aware apps (another Mercury, Claude Desktop, an IDE, etc.) can consume **Mercury's** tools two
ways. Built-in tools appear to them as `mercury_<name>`.

- **HTTP:** the streamable endpoint at `/mcp` (requires a bearer token with the `mcp` scope — see §4.3;
  each tool additionally needs its own scope, e.g. `tools`). Configure with `mcp.server.enabled` /
  `mcp.server.path`.
- **stdio:** `mercury mcp serve` — ideal for desktop apps that launch a local command.

> **Status:** MCP was verified only with an in-memory client↔server roundtrip and an HTTP `/mcp`
> initialize handshake; connections to **real external MCP servers** have not been exercised against
> live services.

## 5.10 Voice

STT/TTS providers are configured under `voice.stt` / `voice.tts` (`openai` default, local
whisper/edge-tts/piper, or any `command`). There is **no mock voice provider** — the mock STT/TTS
branches were removed, so an unconfigured provider now fails explicitly (the `openai` default throws a
`MercuryError` — `stt_unconfigured` / `tts_unconfigured` — when `OPENAI_API_KEY` is missing) instead of
returning silent/placeholder audio. The web UI can record from the mic and play back responses; the
gateway transcribes inbound voice memos. `voice.wakeWord.command` sets an optional wake-word hook.

> **Status:** real voice services and browser mic capture have **not** been run against live services.
> The former mock STT/TTS providers have been removed, so voice now requires a real, configured backend.


---

# Part VI — Tools reference

Mercury ships **81 built-in tools** in **19 toolsets**. Every tool has a **risk** level — `safe`
(runs freely), `moderate` (gated by approval policy when derived from untrusted content), or
`dangerous` (always needs approval). Tools whose output comes from outside (web, files, MCP) are
tagged *untrusted* so they can never silently trigger a sensitive action.

## 6.1 Managing tools

```bash
mercury tools list                 # all tools
mercury tools toolsets             # all toolsets
mercury tools enable <name>        # enable a tool/toolset
mercury tools disable <name>       # disable a tool/toolset
```

Disable tools globally with `tools.disabled[]`, toggle whole toolsets with `tools.toolsets{}`, and
disable toolsets **per platform** (e.g. only on `telegram`) with `tools.platforms.<name>.disabledToolsets`.
In chat, `/tools` lists what is currently available. Over the API: `GET /api/tools`,
`POST /api/tools/:name/run`, `POST /api/tools/toggle`.

## 6.2 The complete catalogue

| Toolset | Tools (risk) |
|---|---|
| **agents** (3) | `delegate_task` (moderate), `run_workflow` (moderate), `list_workflows` (safe) |
| **browser** (6) | `browser_navigate` (safe), `browser_snapshot` (safe), `browser_click` (moderate), `browser_type` (moderate), `browser_back` (safe), `browser_screenshot` (safe) |
| **code** (1) | `execute_code` (moderate) |
| **data** (6) | `json_query` (safe), `csv_parse` (safe), `yaml_convert` (safe), `sqlite_query` (moderate), `archive` (moderate), `document_text` (safe) |
| **decisions** (3) | `decide_choice` (safe), `decide_noul` (safe), `decide_score` (safe) |
| **files** (10) | `read_file` (safe), `write_file` (moderate), `edit_file` (moderate), `list_dir` (safe), `search_files` (safe), `find_files` (safe), `file_info` (safe), `delete_file` (dangerous), `move_file` (moderate), `make_dir` (safe) |
| **git** (4) | `git_status` (safe), `git_diff` (safe), `git_log` (safe), `git_commit` (moderate) |
| **media** (4) | `image_generate` (safe), `text_to_speech` (safe), `speech_to_text` (safe), `describe_image` (safe) |
| **memory** (6) | `memory` (safe), `memory_store` (safe), `memory_recall` (safe), `memory_forget` (moderate), `session_search` (safe), `user_profile` (safe) |
| **messaging** (2) | `send_message` (moderate), `list_platforms` (safe) |
| **process** (4) | `process_start` (moderate), `process_list` (safe), `process_output` (safe), `process_kill` (moderate) |
| **schedule** (3) | `schedule_create` (moderate), `schedule_list` (safe), `schedule_manage` (moderate) |
| **skills** (5) | `skills_list` (safe), `skill_view` (safe), `skill_manage` (safe), `skill_install` (dangerous), `skill_compose` (moderate) |
| **system** (1) | `system_info` (safe) |
| **terminal** (1) | `terminal` (moderate) |
| **utility** (11) | `calculator`, `current_time`, `date_calc`, `unit_convert`, `regex_extract`, `text_diff`, `text_stats`, `hash_text`, `base64`, `uuid`, `todo` (all safe) |
| **vector** (2) | `vector_index` (safe), `vector_search` (safe) |
| **web** (6) | `web_search` (safe), `web_fetch` (safe), `web_read` (moderate), `http_request` (moderate), `rss_read` (safe), `weather` (safe) |

## 6.3 Backends behind the tools

- **`terminal`** runs through the configured backend: `local` (default), `docker`
  (`tools.terminal.dockerImage`, default `node:22-slim`), or `ssh` (`tools.terminal.ssh.{host,user,keyPath}`).
  Dangerous command patterns (`rm -rf /`, disk formatting, fork bombs, `curl | sh`, `sudo`, credential
  access) always require approval.
- **`execute_code`** runs a script in a child process that can call tools back over JSON-RPC, with
  `tools.executeCode.timeoutMs` (30 s) and `maxToolCalls` (50) limits and a scrubbed environment.
- **`browser_*`** uses Playwright when installed, otherwise a fetch-based fallback (`tools.browser.backend`
  = `auto`|…, `cdpUrl` to attach to a remote Chrome).
- **`web_*`** go through `safeFetch` (SSRF guard + size cap); search provider is `tools.web.searchProvider`
  (`duckduckgo` default — works with no key; `searxng` requires `searxngUrl`; `brave` requires
  `BRAVE_API_KEY`). The `mock` search provider and the mock-weather branch have been removed.
- **`web_read`** (1.1.1) runs `extractMainContent` to return just the readable article text (stripping
  nav/ads/boilerplate). It is `moderate` risk, `sensitive` and marked `untrustedOutput`, so it **always
  needs approval** and its output stays spotlighted. It has two backends behind the one extraction
  pipeline: the default **HTTP** backend (`safeFetch`, no JavaScript) and an opt-in **headless-browser**
  backend — `render=true` on the call, or `tools.web.render: true` as the default — which renders the
  live DOM through `tools.browser.backend` (playwright/cdp) for client-rendered pages. The entry URL is
  SSRF-checked before any real-browser navigation, and the tool degrades to the HTTP path when no browser
  backend is installed (reporting which backend ran in its `data.backend`).
- **`image_generate`** uses `tools.image.provider` (`openai` default, or an OpenAI-compatible image
  provider / model). The `mock` SVG image provider has been removed; the `openai` default throws
  `OPENAI_API_KEY is not set` when unconfigured.
- **`file_*`** are confined by the path jail (`tools.jail`).

> **Status:** the Docker and SSH terminal backends, the Playwright browser backend, real web-search
> providers, and real image generation have **not** been exercised against live services (only the
> local terminal and the fetch browser backend were run). The former mock search/weather/image
> branches have been removed, so these tools now require a real, configured backend and fail explicitly
> otherwise. The Go polyglot example tool (`tools/hash_go`) is present but no Go toolchain is installed
> in the test environment.

## 6.4 Polyglot tools (any language)

Any executable with a `tool.json` manifest becomes a tool — Mercury writes JSON arguments to its
stdin and reads the result from stdout (a non-zero exit is reported as an error). Discovered from
`tools/`, `$MERCURY_HOME/tools/<name>/` and `tools.polyglotDirs`. Bundled examples: Python
(`word_count_py`), JavaScript (`slugify_js`), Go (`hash_go`). Authoring: Part VIII.


---

# Part VII — The decision engine (Jev)

Jev is a typed decision/judgment model (`typesafe/jev-1.13`, served via the OpenRouter
Decisions API). Mercury uses it as a calibrated decision-maker in two families:

- **Routing / judgment:** model selection, pattern/workflow selection, tool-approval gating,
  prompt-injection classification, and gateway message/mail triage.
- **Meta-cognition:** step and answer **scoring** (Score), **retry/escalate** (Noul), **next-strategy**
  (Choice), and calibration (predicted vs. observed outcomes, Brier score).

**It is entirely optional.** `decision.provider` selects the mode:

| Mode | Behaviour |
|---|---|
| `auto` (default) | Use Jev **only** when `OPENROUTER_API_KEY` is set; else your configured LLM; else a built-in heuristic. |
| `jev` | Force Jev (requires the OpenRouter key). |
| `llm` | Use your normal LLM for decisions, never Jev. |

The `mock` decision provider has been removed from normal operation (and dropped from the
`decision.provider` enum). A deterministic mock decision provider is still appended **only** when
`MERCURY_ENABLE_MOCK=1` is set — the sanctioned test/offline escape hatch — never in production.

Mercury runs fully without Jev — every decision degrades to the LLM or the built-in heuristic.

**Configuration** (`decision.*`): `jev.model` (`typesafe/jev-1.13`), `jev.baseUrl`
(`https://openrouter.ai/api/alpha`), `jev.apiKeyEnv` (`OPENROUTER_API_KEY`), `jev.timeoutMs` (20 s);
`llmModel` (which model answers when in `llm` mode); the confidence **thresholds** — `injection` 0.7,
`toolApproval` 0.8, `triageReview` 0.8, `retry` 0.6, `answerQuality` 0.5; and `use.*` switches to turn
each decision type on/off individually (`routing`, `patternSelection`, `toolGate`, `injection`,
`triage`, `reflection`, all default true).

The three decision shapes are also exposed as tools (`decide_choice`, `decide_noul`, `decide_score`)
and over the API (`GET /api/decisions`, `POST /api/decisions/try`).

> **Status:** the Jev provider was tested only with **mocked HTTP** (request/answer parsing, retry on
> transient errors, fail-fast on 4xx, fallback chain). It has **not** been run against the real
> OpenRouter Decisions API.

---

# Part VIII — Changing & extending Mercury

Mercury loads extensions both from the repository (bundled) and from `$MERCURY_HOME` (default
`~/.mercury`). Scaffold any of them with `mercury new <kind> <name>`:

```bash
mercury new tool my_tool --lang python     # also: js | go | cpp | java
mercury new skill my_skill
mercury new workflow my_flow
mercury new adapter my_platform
mercury new plugin my_plugin
```

| Extension | Where it's discovered | Format |
|---|---|---|
| Polyglot tool | `tools/<name>/`, `$MERCURY_HOME/tools/<name>/`, `tools.polyglotDirs` | `tool.json` + any executable |
| Skill | `skills/<name>/`, `$MERCURY_HOME/skills/`, `skills.dirs`, git | `SKILL.md` (agentskills.io frontmatter) |
| Workflow | `workflows/*.yaml`, `$MERCURY_HOME/workflows/` | YAML naming a template `type` |
| Personality | `personalities/*.md`, `$MERCURY_HOME/personalities/` | Markdown system-prompt overlay |
| Plugin | `$MERCURY_HOME/plugins/<name>.mjs` or `<name>/index.js`, `plugins:[]` | ES module exporting a `Plugin` |
| Gateway adapter | via a plugin's `registerAdapter()` | class implementing `Adapter` |
| MCP server tools | `mcp.servers` / `mercury mcp` | any external MCP server |

## 8.1 Polyglot tools

A folder with a `tool.json` manifest and an executable. Mercury pipes JSON args to stdin and returns
stdout; a non-zero exit is an error.

```json
{
  "name": "slugify",
  "description": "Turn a title into a URL-friendly slug.",
  "toolset": "polyglot",
  "risk": "safe",
  "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "command": ["node", "main.mjs"],
  "requires": ["node"]
}
```

`risk` controls approval gating; `requires` lists binaries that must be on `PATH` (the tool is hidden
when they are missing).

## 8.2 Skills

```markdown
---
name: code-review
description: Review a code change for bugs and security issues. Use when the user asks for a review.
metadata: { version: 1, tags: [code, quality] }
---
# Code review
1. Read the files — do not guess.
...
```

The `description` is what the model sees when deciding whether to load the skill. Skills are also
exposed as MCP prompts and `skill://` resources. Install with `mercury skills install <path|git-url>`.

## 8.3 Workflows

```yaml
name: debate
description: Two agents argue, a judge decides.
type: debate     # single | pipeline | round-robin | coordinator-worker | tree | map-reduce | router | blackboard | debate
agents:
  - { name: proponent, role: Argue FOR the proposition. }
  - { name: opponent,  role: Argue AGAINST the proposition. }
  - { name: judge,     role: Weigh both sides and give a verdict. }
options: { rounds: 2 }
budget: { maxRuns: 8 }
```

Run with `mercury workflow run debate "<input>"`, from the web UI, or via the `run_workflow` tool.
`type: auto` lets the decision engine choose a template.

## 8.4 Plugins

A plugin is an ES module exporting a `Plugin` with a `setup(api)` function:

```js
// ~/.mercury/plugins/hello.mjs
export default {
  name: 'hello',
  version: '1.0.0',
  setup(api) {
    api.registerTool({
      name: 'hello', description: 'Say hello', toolset: 'custom', risk: 'safe',
      parameters: { type: 'object', properties: { who: { type: 'string' } } },
      async execute(args) { return `Hello, ${args.who ?? 'world'}!`; },
    });
    api.registerHook('before_tool_call', (payload) => { api.logger.info('tool', { tool: payload.tool }); });
  },
};
```

`PluginAPI` (`packages/core/src/plugins/plugin.ts`) offers: `registerTool`, `registerHook`,
`registerMemoryProvider`, `registerContextEngine`, `registerLLMProvider`, `registerDecisionProvider`,
`registerPattern`, `registerWorkflowTemplate` and `registerAdapter`. List loaded plugins and load
errors with `mercury plugins`. Register the module in `plugins:[]` or drop it in
`$MERCURY_HOME/plugins/`.

## 8.5 Gateway adapters

Implement the `Adapter` interface from `@mercury/gateway` (or extend `BaseAdapter`): `name`, `type`,
optional `textOnly`, `start(sink)`, `stop()`, `send(out)`, `status()`, and optional
`handleWebhook(req)` (mounted at `/webhooks/<name>`). Use the injected `deps.transport` for HTTP; it
defaults to the real `FetchTransport`, and for tests you can inject the test-only `MockTransport` from
`tests/mock-transport.ts` (it is no longer part of the shipped `@mercury/gateway` package — the
production `transport.ts` exports only `wrap()` and `FetchTransport`). Register it from a plugin with
`api.registerAdapter('myplatform', (config) => new MyAdapter(...))`, then enable it under
`gateway.adapters.myplatform`.

## 8.6 LLM, decision, memory & pattern providers

- `LLMProvider` — implement `chat()`/streaming for a `provider/model` id; register with
  `api.registerLLMProvider`.
- `DecisionProvider` — answer typed questions (`choice`, `noul`/boolean, `score`) with confidences;
  `packages/core/src/decision/jev.ts` is a compact reference.
- `Pattern` — a reasoning loop; register with `api.registerPattern` or drop in
  `~/.mercury/patterns/*.js`. Built-ins: `react`, `cot`, `plan-execute`, `reflexion`, `tot`,
  `self-consistency`, `critic`.
- `MemoryProvider` / `ContextEngine` — plug in external memory or a custom context builder.
- **Personalities** are `*.md` system-prompt overlays; **hooks** can be declared in `config.hooks`
  (type `log` or `webhook`) or registered by plugins.

## 8.7 Build, test & lint loop for contributors

```bash
npm run build      # tsc project references
npm test           # vitest (offline; 185 tests)
npx eslint .       # lint (exits 0)
```

Keep `core` free of HTTP/server concerns (it depends only on `zod`, `yaml` and Node built-ins).
Follow the dependency direction `cli, server → runtime → {tools, mcp, gateway} → core`. Full
guidance: [EXTENDING.md](EXTENDING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

---

# Part IX — Observability & debugging

**Everything is an event.** Every LLM call, tool call, memory op, decision, guardrail verdict and
thought is published on the `EventBus`, persisted to the `events` table, and streamable to the UI —
each event carries `runId`, `spanId` and `parentSpanId`.

- **Run traces:** `GET /api/runs`, `GET /api/runs/:id/events`; the web **Runs** and **Debug** panels
  render them live. `POST /api/runs/:id/feedback` and `/stop` rate or abort a run.
- **Replay:** `mercury replay <runId>` re-plays a recorded run's events.
- **Live debugging:** `/debug on|off|llm|tool|list|resume <id>|skip <id>` in chat, or
  `GET /api/debug`, `POST /api/debug/breakpoints`, `POST /api/debug/resume/:id`. Set breakpoints on
  LLM or tool steps, inspect, then resume or skip.
- **Metrics:** Prometheus at `GET /metrics` (`observability.metrics`); optional OTLP export via
  `observability.otlpEndpoint`. Event recording toggles with `observability.recordEvents`.
- **Reflections:** after a run, Mercury can score the outcome, extract lessons, update the user model
  and create/refine skills (`reflection.*`). View via `GET /api/reflections` or the Reflections panel.
- **Insights & usage:** `/usage` (this session) and `/insights [days]` (trends; admins can see all),
  also `GET /api/events`.


---

# Part X — Security model

Treat Mercury like a remote shell for whoever can log in: it can run commands, read files, browse the
web and talk to chat platforms. The full threat model is [SECURITY.md](SECURITY.md); this is the
summary.

**Authentication & authorization.** Passwords hashed with scrypt; the first user is admin, the rest
are `user`. Sessions are HS256 JWTs signed with `$MERCURY_HOME/secret.key` (default 7-day lifetime).
API tokens (`mrc_…`, stored as SHA-256 hashes, optional expiry) carry scopes (`chat, agent, workflow,
memory, skills, tools, schedule, mcp, admin, read, *`). RBAC enforces admin-only routes; each user's
data is scoped to them. The `/mcp` endpoint needs the `mcp` scope plus each tool's own scope. Per-client
rate limiting (`server.rateLimit`). Adapter webhooks verify platform signatures (401 on failure).

**Prompt-injection defence (layered).** (1) **Input** — a heuristic scanner scores every message;
untrusted sources and suspicious text are additionally classified by the decision engine, and scores
above `decision.thresholds.injection` (0.7) are blocked. (2) **Context** — untrusted content is
*spotlighted* inside `<untrusted_content>` markers with an explicit "data, not instructions" notice,
and the system prompt states the instruction hierarchy (`system > user > trusted_tool > untrusted`).
(3) **Action** — when untrusted content is in context, sensitive (write/send/execute) tools need
approval per `tools.approvals.mode`. (4) **Output** — secrets are redacted, PII optionally redacted,
and a random canary detects prompt leaks. These layers reduce, but cannot eliminate, injection risk —
keep approvals on `manual` whenever the agent reads untrusted content.

**Tool sandboxing.** Path jail for file tools; dangerous shell commands flagged and always gated;
SSRF guard on web tools (blocks private/loopback/link-local, caps size); terminal isolation via the
`docker`/`ssh` backends; token/cost budgets to stop runaway loops.

**Gateway.** Unknown chat users get a pairing code; nothing reaches the agent until an admin approves.
Low-confidence messages can be routed to human review (triage).

**Audit & observability.** Append-only, hash-chained audit log (SQL triggers forbid UPDATE/DELETE;
`verify()` detects tampering) — records registration, user/role updates, config changes, successful
and failed logins, API token issuance/revocation and gateway pairing approvals/rejections, and is
queryable (admin-only `GET /api/audit` and `mercury audit`); every run also keeps a full event trace.

**Deployment checklist.** TLS in front of the server; register admin then disable registration; keep
`$MERCURY_HOME` private; prefer scoped, expiring tokens over admin JWTs; run under Docker/systemd, not
as root; leave approvals on `manual` unless input is fully trusted.

---

# Part XI — Architecture for developers

Full detail is in [ARCHITECTURE.md](ARCHITECTURE.md); this orients you quickly.

**Design principles:** small explicit interfaces for every subsystem; offline-first for development and
tests (the mock LLM/decision providers behind `MERCURY_ENABLE_MOCK=1`, hash embeddings) while
integrations require real configuration; one composition root (`createMercury()` in
`@mercury/runtime` wires everything — the CLI, server, gateway, scheduler and MCP server are thin
front-ends over it); everything is an event; untrusted-by-default content handling.

**Layers:** Frontends (CLI, server+SPA, MCP server, gateway, scheduler) → Composition (runtime) →
Orchestration (agent + patterns, workflow engine, reflection) → Judgment (decision engine) →
Capabilities (LLMs+router, tools, memory, skills, voice, attachments) → Foundation (config, DB,
events, logging, security, auth, budgets, i18n, help).

**One chat turn:** frontend → `Agent.run()` → input guardrail → build context (context files, curated
memory, skills index, recall) → router picks a model (rules → capability filter → weighted score →
optional Jev choice → fallback) → pattern loop (budget check → LLM stream → tool executor with policy/
approval/hooks/sandbox/timeout, external results tagged untrusted → repeat) → output guardrail
(redaction) → stream answer → post-run reflection. Every arrow emits a persisted event.

**Key subsystems:** the `ReactLoop` primitive (with a text-ReAct fallback for models lacking native
tool calling), seven reasoning patterns, the `DecisionEngine` (Jev/LLM providers — plus a gated mock
for tests — with a fallback
chain), the model router + budget service, the six-kind memory system (working, episodic, semantic,
curated, procedural/skills, user model, blackboard), skills with progressive disclosure, the tool
executor pipeline, the workflow spawner (depth/concurrency/budget limits), the gateway, and the
scheduler. **Packages & dependency direction:** `cli, server → runtime → {tools, mcp, gateway} → core`;
`core` depends only on `zod`, `yaml` and Node built-ins.

Mercury-only additions beyond Hermes parity: the Jev decision engine, reasoning patterns, multi-agent
workflow templates, RBAC/ABAC + API tokens, token budgets, the MCP *server*, a hash-chained audit log,
debug breakpoints and run replay, the web UI, i18n, and the polyglot tool protocol.



---

# Part XII — The trust stack: economics, governance, verification, reliability & proactivity

These five subsystems turn a capable agent into one you can hand real work and real credentials. All
are config-driven and backward-compatible — new keys default to safe values, and chaos and proactivity
are off until enabled.

## 12.1 Economics & routing

Mercury selects the cheapest model *likely to succeed* rather than always the biggest. Model profiles
carry a `lane` (`local` | `frontier` | `default`); the router infers task difficulty from cheap offline
signals and picks the cheapest model whose quality tier clears that bar, keeping routine work on the
near-zero-cost local lane and routing hard work to frontier/default models (`router.economics`:
`enabled`, `localLaneMaxDifficulty`, `qualityMargin`; each route reports `lane` and `qualityNeed`). On
top of recurring quotas, **hard per-task budgets** (`TaskBudgetService`) enforce a cost/token ceiling
per run — checked before every model call — and halt or escalate on exceed (`budgets.perTask`:
`enabled`, `maxCost`, `maxTokens`, `onExceed`, `projectedSteps`). The **Models & budgets** panel and
`GET /api/tasks[/:id]` show a live cost-vs-value card (cost so far, projected cost, value/cost ratio,
budget-used, over-budget flag).

## 12.2 Governance & security

Four layers guard sensitive actions. **Credential grants** (`GrantBroker`) are scoped, time-limited and
task-bound — no standing keys; ephemeral credentials are minted in memory and never persisted
(`GET/POST /api/grants`, `DELETE /api/grants/:id`, `security.grants`). **Policy-as-code**
(`PolicyCodeEngine`) evaluates `allow`/`deny`/`approve` rules (strictest wins) before sensitive tool
actions, e.g. "no payments over €100 without approval" (`GET /api/policies`, `POST /api/policies/test`,
`security.policies`). **Taint tracking** marks and propagates untrusted tool output and lets policy
rules gate on `whenTainted`. The **replayable audit trail** (`buildTrace`, `GET /api/runs/:id/trace`)
turns a run into an ordered "why did you do that?" explanation. Managed from the **Governance** panel;
see [SECURITY.md](SECURITY.md) and [PERMISSIONS.md](PERMISSIONS.md).

## 12.3 Verification

Completion is decided on evidence. The verifier runs pluggable checks — `test` (real shell command,
exit 0 = pass), `schema` (JSON-schema), `assertion` (substring/regex/predicate) and `critic` (the Jev
decision engine as judge, no mock) — each returning a 0..1 confidence and a reason. The `Verifier`
aggregates them; below `verification.confidenceThreshold` the run is escalated for human review rather
than silently passing. Use the **Verification** panel or `GET /api/verifications[/:id]`,
`POST /api/verify`, `GET /api/escalations`, `POST /api/escalations/:id/resolve`. Checks are opt-in per
step; configure under `verification`.

## 12.4 Reliability engineering

`RunRecorder` snapshots a real run and `ReplayService` re-runs it through the live agent, diffing
status, tool sequence and output similarity to catch regressions (`mercury reliability
record|recordings|replay`, `GET/POST /api/recordings`, `POST /api/recordings/:id/replay`).
`ChaosController` injects failures/timeouts/latency into the real tool path — deterministic, seedable,
tool-glob gated, and **off by default** (`reliability.chaos.enabled = false`; `mercury reliability
chaos`, `GET /api/chaos`). `SloService` computes per-agent success rate, intervention/escalation rate
and cost-per-task vs targets (`mercury reliability slo`, `GET /api/slo`). See the **Reliability** panel
and `reliability` config; built on the primitives in [RELIABILITY.md](RELIABILITY.md).

## 12.5 Proactive (but not annoying)

Event sources produce events — `GatewayEmailSource` reacts to real inbound email via the gateway's
`gateway.inbound` event, `WebhookSource` ingests webhook/CI events via `POST /api/proactive/events`.
Declarative rules (source/kind glob + substring) map events to an optional agent action and base
priority. `scorePriority` scores each event 0..1 (urgent/security/CI-fail raise it, newsletters/FYIs
lower it); events ≥ `proactive.interruptThreshold` interrupt immediately, the rest defer into a digest
queue that is bundled and delivered on a cron (`proactive.digestCron`) via the scheduler. Drive it from
the **Proactive** panel or `mercury proactive rules|events|digest|emit|flush|poll` /
`GET /api/proactive`, `POST /api/proactive/events|digest/flush|poll`. Disabled by default; configure
under `proactive`.

## 12.6 Learning from runs (1.1.1)

Mercury can learn from its own completed runs. The `LearningService` does three things, each degrading
gracefully when there isn't enough data, and the whole subsystem is **off by default**
(`learning.enabled: false`):

- **Experience hints** — at the start of a run it searches for a similar past *successful* run and
  injects a short hint into the agent's context (`hints.maxExamples`, `hints.minSimilarity`,
  `hints.lookback`). No similar run means no hint — nothing is forced.
- **Auto-tuned routing** — a `RouteLearner` hook in the model router records success rates per
  (difficulty bucket, model) and feeds them back to routing. The router only prefers a learned model
  once there are at least `routing.minSamples` samples above `routing.minSuccessRate`; otherwise it
  falls back to economics. A learning-adjusted decision is flagged `adjustedByLearning`.
- **Failure playbooks** — recurring error signatures and the remediation that later worked are
  persisted (`playbooks.minOccurrences`, `playbooks.minSimilarity`) so known failures can be avoided.

State is stored by DB **migration #6** (`learning_route_stats`, keyed by `(bucket, model)`, and
`learning_playbooks`, keyed by error signature). Inspect it from the CLI or API:

```bash
mercury learn stats [bucket]      # observed routing success rates (add --json)
mercury learn hints <task...>     # preview the hint that would be injected for a task
mercury learn playbooks           # recorded failure playbooks and their remediations
```

Over HTTP: `GET /api/learning` (status + config + route stats + playbooks; scope `audit.read`),
`GET /api/learning/stats` (`?bucket`), `GET /api/learning/playbooks` (`?limit`), `GET /api/learning/hint`
(`?task`). The web UI **Learning** panel (admin-only) shows the same status, auto-tuned routing table and
failure playbooks. Configure under `learning` (see Appendix B) and the [`learning` help](help/learning.md).

## 12.7 Self-distilling skills (1.2.0)

Beyond the hand-written skills of §5.6, Mercury can **distil its own** reusable, parameterized skills
from runs that went well. The subsystem is **off by default** (`skills.distill.enabled: false`).

- **Distillation** — after a successful run, or when you 👍 a run, the proven tool sequence is captured
  and its concrete values are generalized into named parameters. A winning run needs at least
  `minToolCalls` tool calls to be eligible. A new trace that is ≥ `dedupMinSimilarity` similar to an
  existing skill updates it and bumps its version instead of creating a duplicate.
- **Governance** — new skills start as `pending` and are inert until approved, unless `autoApprove`
  promotes them immediately. Approve or retire from the **Distilled Skills** panel or over HTTP.
- **Promote/demote by evidence** — each use updates the skill's success-rate and average-cost stats;
  a skill below `retireBelowSuccessRate` after at least `minRunsBeforeRetire` uses is auto-retired,
  and `maxSkills` caps retention (oldest retired pruned first).
- **Reuse** — when an incoming task matches an approved skill ≥ `matchMinSimilarity`, the proven path
  is injected into the agent's system prompt as a strong "proven skill" plan hint.

State is stored by DB **migration #7** (`distilled_skills`). Over HTTP: `GET /api/distilled-skills`
(list), `POST /api/distilled-skills/:id/approve`, `POST /api/distilled-skills/:id/retire` (auth-gated).
Configure under `skills.distill` (see Appendix B) and the [`skills` help](help/skills.md).

## 12.8 Deterministic run replay & time-travel debugging (1.2.0)

Mercury persists a trace of every run's event stream so you can replay and debug it like a recording.
This is **on by default** (`replay.enabled: true`) and backward-compatible.

- **Trace** — each run's `input`, deterministic `seed`, ordered steps and (for forks) lineage are
  stored by DB **migration #8** (`run_traces`). `retainTraces` caps how many are kept.
- **Time-travel** — list traced runs, scrub the timeline, and inspect the reconstructed state at any
  step (LLM/tool-call counts, cost, tokens, taint). Per-step deltas are recomputed on demand; set
  `persistDeltas` to also store them (larger traces).
- **Fork & re-run** — pick a step, optionally edit an input, and re-run from there: a new linked run
  (`parent_run_id` + `from_step`) reuses the upstream prefix and deterministically recomputes
  everything downstream. The recomputed portion runs the real agent path, so governance/approvals
  still apply to it.

Programmatically via the `mercury.traces` facade (`listTraces`, `getTrace`, `getStateAt`, `replayFrom`).
Over HTTP: `GET /api/traces`, `GET /api/runs/:id/timetravel`, `GET /api/runs/:id/state?step=N`,
`POST /api/runs/:id/replay {fromStep, edits}`. The web UI **Run Replay** panel (admin-only) drives all
of this. Configure under `replay` (see Appendix B) and the [`replay` help](help/replay.md).

## 12.9 Evaluation-driven self-improvement (1.3.0)

Mercury can turn real behaviour into a scored regression gate and let a **governed** auto-tuner improve
the agent against it. The harness is **on by default** (`evals.enabled: true`, safe — it only
reads/scores); the auto-tuner is **off by default** (`evals.autotune.enabled: false`, it mutates
config).

- **Promote** — turn a real (or 👍-rated) run into a labeled eval case capturing the input and the
  expected tools / output substrings / cost ceiling, grouped into a suite.
- **Score** — run a suite and get a deterministic, weighted 0..1 score over **pass-rate**,
  **cost-per-task**, **intervention-rate** and **output-similarity** (weights under `evals.weights`).
  Scores are persisted (retention `evals.retainScores`) and trendable.
- **Tune (governed)** — propose changes (model routing, pattern, temperature, skill promote/retire,
  prompt); each is tested against the suite and accepted **only** if it improves the score by at least
  `evals.autotune.minImprovement` **without** exceeding the per-task budget ceiling
  (`evals.costCeiling`) or touching governance-protected config (`security.*`, `governance.*`,
  `approvals.*`, `policies.*`). Accepted tunes auto-apply only when both `autotune.enabled` and
  `autotune.autoApply` are set; otherwise they await explicit approval.
- **Reverse** — every applied tune is versioned and reversible.

State is stored by DB **migrations #9/#10** (`eval_suites`, `eval_cases`, `eval_scores`,
`tune_history`). Programmatically via the `mercury.evals` facade (`promoteRun`, `runSuite`,
`proposeTune`, `applyTune`, `revertTune`, `listTunes`). Over HTTP: `GET/POST /api/evals/*` (auth-gated;
reads need `audit.read`, mutations `config.manage`). The web UI **Evaluations & Auto-tune** panel
(admin-only) drives all of this. Configure under `evals` (see Appendix B) and the
[`evals` help](help/evals.md).

## 12.10 Sharable Agent Bundles (1.3.0)

Package a running agent's configuration into one portable, signed artifact ("Mercury pack") and install
it into another instance in one command. **On by default** (`bundles.enabled: true`).

```bash
mercury bundle export --sections skills,workflows,personality --out team.mbundle
mercury bundle inspect team.mbundle          # manifest + sections + signature/compat, no install
mercury bundle install team.mbundle          # verify signature → check compat → idempotent apply
mercury bundle list                          # installed bundles
```

- **Export** any subset of `skills`, `workflows`, `personality`, `policy`, `mcp` into a bundle with a
  manifest (name, version, `mercuryVersion`, `formatVersion`) and an HMAC-SHA256 signature.
- **Integrity** — install verifies the signature (any tampering fails) when `bundles.requireSignature`,
  and checks version/compatibility before applying.
- **Idempotent** — re-installing the same bundle digest is a no-op.
- **Governed** — bundled `policy` and `mcp` sections are **queued for approval** (not applied silently)
  unless `bundles.autoApprovePolicy` / `bundles.autoApproveMcp` are set; approve them through the normal
  governance path.

State is stored by DB **migration #11** (`installed_bundles`). Programmatically via the
`mercury.bundles` facade (`export`, `exportToFile`, `inspect`, `install`, `approvePending`, `list`).
Over HTTP: `GET/POST /api/bundles/*` (auth-gated). The web UI **Agent Bundles** panel (admin-only)
offers export/download and install/upload. Configure under `bundles` (see Appendix B) and the
[`bundles` help](help/bundles.md).

## 12.11 Governed long-term memory & knowledge (1.4.0)

The memory subsystem is now **policy-governed, PII-aware, retention-bounded, namespaced and
auditable**, plus a knowledge/RAG store with provenance. Everything is **off/soft by default** and
backward-compatible.

```bash
mercury memory remember "Ship v1.4.0 on Nov 22" --ns releases
mercury memory recall "release date" --ns releases
mercury memory ns                                  # namespaces with counts
mercury memory knowledge add "$(cat handbook.md)" --title Handbook
mercury memory knowledge search "how do teams work"
mercury memory audit --decision redact            # governed decision ledger
```

- **Namespaces** add a dimension on top of the per-user scope; retention (`memory.retention.*`) prunes
  by TTL and max-items-per-namespace.
- **PII** is detected and either redacted (default) or blocked (`memory.governance.pii.*`); set
  `memory.governance.enforcePolicy` to route reads/writes through the policy engine.
- **Audit** — every governed decision lands in the queryable `memory_audit` ledger (`mercury memory
  audit`, `GET /api/memory/audit`) and the global audit bus.
- **Knowledge/RAG** — ingest documents (chunk + embed) and recall with provenance via hybrid
  FTS+vector search; when `memory.knowledge.enabled`, knowledge grounds the agent's context. Memory
  config is a shareable **bundle section**, and evals can measure the memory lift.

Programmatically via the `mercury.memory` facade (new methods `namespaces`, `auditLog`,
`addKnowledge`, `searchKnowledge`); state is stored by DB **migrations #12–#13**. Configure under
`memory` (see Appendix B) and the [`memory` help](help/memory.md).

## 12.12 Multi-agent orchestration — teams (1.4.0)

Compose role-specialised agents into one governed, budget-aware run. **Off by default**
(`teams.enabled: true`).

```bash
mercury team create researchers \
  --members "lead:plan the research;writer:draft the report" --strategy coordinator
mercury team run researchers "Summarise the latest release" --budget 2
mercury team runs                                  # recent run records
mercury team show researchers
```

- **Strategies** — `coordinator` (plan → parallel workers → synthesise), `pipeline` (sequential, output
  chained) or `debate` (all answer → synthesise/pick).
- **Governed** — runs check `teams.run` policy, honour an optional approval gate and a per-run
  **budget ceiling** (members skipped once hit); `teams.manage` (admin) governs create/delete.
- **Resilient** — a failing member becomes an `error` step (run status `partial`) instead of crashing
  the whole run. Definitions and run records are persisted and auditable.

Programmatically via the `mercury.teams` facade; state is stored by DB **migrations #14–#15**.
Over HTTP: `GET/POST /api/teams/*` (auth-gated). The web UI **Teams** panel (admin-only) creates and
runs teams. Configure under `teams` (see Appendix B) and the [`teams` help](help/teams.md).

---

## Appendix A — Full CLI reference

The CLI is invoked as `mercury <command>` once installed (`npm link` or the published bin), or as
`node packages/cli/dist/bin.js <command>` from a source checkout. Every command accepts `--help`.
Global behaviour: configuration is resolved from defaults < `~/.mercury/config.yaml` < environment
variables < CLI flags (see Appendix B), and `MERCURY_HOME` overrides the data directory for any command.

| Command | Purpose | Key flags / sub-arguments |
| --- | --- | --- |
| `chat [message]` | One-shot or interactive chat with the agent. With no message, starts an interactive REPL. | `--model <id>`, `--session <id>`, `--pattern <name>`, `--user <id>` |
| `serve` | Start the HTTP server (REST + SSE + web UI + MCP endpoint). | `--port <n>` (default 3000) |
| `setup` | Interactive first-run wizard: creates the admin user, picks a provider and default model, writes config. | `--username`, `--password`, `--provider`, `--model` |
| `model [provider/model]` | Show the active default model, or set it (e.g. `model openai/gpt-4o`). | — |
| `tools` | Inspect and toggle tools. | `list`, `toolsets`, `enable <name>`, `disable <name>` |
| `skills` | Manage skills (progressive-disclosure procedural memory). | `list`, `view <name>`, `install <src>` |
| `schedule` | Manage scheduled tasks. | `list`, `add --when "<cron / natural>"`, `pause <id>`, `resume <id>`, `delete <id>`, `run <id>` |
| `workflow` | Run and list multi-agent workflows (incl. `planner-executor`). | `list`, `run <name> <input>` |
| `learn` | Inspect learning from runs (experience hints, auto-tuned routing, failure playbooks). | `stats [bucket]`, `hints <task...>`, `playbooks`; `--json`, `--limit <n>` |
| `config` | Inspect and edit configuration. | `path`, `get <key>`, `set <key> <value>` |
| `gateway` | Manage the messaging gateway and device pairing. | `status`, `start`, `pending`, `pair <CODE>` |
| `mcp` | MCP client/server helpers and curated presets. | `status` (default), `presets`, `enable <preset>` (`--name <n>`, `--connect`), `list`, `serve` |
| `user` | User administration (admin only). | `list`, `add`, `passwd`, `role`, `delete` |
| `token` | Manage API tokens. | `list`, `create <name> --scopes <...>`, `revoke <id>` |
| `audit` | Read and verify the hash-chained audit log (admin). | `list` (filters: `--actor <id>`, `--action <name\|prefix>`, `--target <t>`, `--since <ISO>`, `--until <ISO>`, `--limit <n>`, `--offset <n>`, `--json`), `verify` |
| `plugins` | List loaded plugins. | — |
| `wiki` | Manage the LLM Wiki — ingest immutable sources, query synthesised pages, lint. See [WIKI.md](WIKI.md). | `init`, `status`, `ingest <path\|->` (`--name`, `--instruction`), `query "<q>"` (`--k <n>`), `lint` (`--delta`, `--no-llm`) |
| `addin` | Inspect or scaffold declarative add-ins (tools / personalities / permission profiles dropped into `<dataDir>/addins/`, no source edits). See [ADDINS.md](ADDINS.md). | `list`, `scaffold <name>` |
| `perms` | Inspect per-agent/personality permission profiles and their effective (intersection) policy. See [PERMISSIONS.md](PERMISSIONS.md). | `list`, `show <personality>` |
| `import-agent [path]` | Import an existing Hermes agent/config (default `~/.hermes`). | — |
| `new <kind> <name>` | Scaffold a new extension. `kind` ∈ `tool\|skill\|workflow\|adapter\|plugin`. | `--lang <python\|js\|go\|cpp\|java>` |
| `replay <runId>` | Re-run a recorded run from its persisted events (debugging). | — |
| `eval` | Run the built-in deterministic self-evaluation suite against the agent and report pass/score with per-run token/cost accounting. | `--tag <tag>` (filter: `basic\|tools\|memory\|reasoning\|grounding`), `--json` |
| `bundle <list\|export\|inspect\|install>` | **Sharable agent bundles (1.3.0)** — export selected config sections to a signed bundle, inspect one without installing, install one (verify signature → check compat → idempotent governed apply), or list installed bundles. | `--sections <a,b>`, `--out <file>`, `--version <v>`, `--desc <text>`, `--author <name>`, `--json` |
| `doctor` | Environment / configuration health check (see Appendix E). | — |
| `update` | Self-update the installation. | — |
| `help [topic]` | Show help; with a topic, prints the matching help doc. | — |
| `version`, `-v` | Print the version (prints `mercury 1.4.0`). | — |

> **Version note.** This guide documents the **1.4.0** release (the root `package.json` is `1.4.0`).
> `mercury version` in `packages/cli/src/bin.ts` resolves its string dynamically from the CLI
> package.json, so it reports `mercury 1.4.0` and tracks the release automatically.

> Honest-status note: `import-agent`, `update`, and `install.sh` have been exercised only against the
> offline/mock setup in this repository; they have not been validated against a real Hermes install, a
> real release feed, or a real update channel.

---

## Appendix B — Full configuration key reference

Configuration lives in `~/.mercury/config.yaml` (YAML). Precedence, lowest to highest: **built-in
defaults → config file → environment variables → CLI flags**. Every key below is optional; the value
shown is the default applied when the key is omitted. Keys are grouped by their top-level section.

### Top level

| Key | Default | Notes |
| --- | --- | --- |
| `dataDir` | `''` | Data directory; empty means `~/.mercury` (or `MERCURY_HOME`). |
| `locale` | `'en'` | UI/response locale. |
| `logLevel` | `'info'` | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `debug` | `false` | Enables verbose debug behaviour. |

### `server`

| Key | Default | Notes |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | Bind address. |
| `server.port` | `3000` | Listen port. |
| `server.publicUrl` | *(unset)* | External base URL (for links/webhooks). |
| `server.rateLimit.windowMs` | `60000` | Rate-limit window (ms). SQLite-backed limiter (`rate_limits` table). |
| `server.rateLimit.max` | `300` | Max requests per window. |
| `server.maxBodyBytes` | `31457280` (30 MB) | Max request body size. |

### `auth`

| Key | Default | Notes |
| --- | --- | --- |
| `auth.tokenTtlHours` | `168` (7 days) | JWT lifetime. |
| `auth.allowRegistration` | `true` | Allow self-registration via `/api/auth/register`. |

### `llm`

| Key | Default | Notes |
| --- | --- | --- |
| `llm.defaultModel` | `'auto'` | `auto` defers to the router. |
| `llm.providers` | `{}` | Map of provider → `{ type, baseUrl?, apiKey?, apiKeyEnv?, headers?, enabled:true }`. |
| `llm.models` | `[]` | Each: `{ id, tags[], quality:0.5, costPer1MInput:0, costPer1MOutput:0, latencyMs:1000, contextWindow:8192, tools:true, vision:false, audio:false, json:true, enabled:true }`. |
| `llm.retries` | `2` | Max retries of a retryable provider error (per model, before fallback). |
| `llm.retryBackoffMs` | `500` | Base delay for exponential backoff between retries (`base·2^attempt`). |
| `llm.retryJitter` | `0.5` | Jitter fraction (0..1) added to each backoff delay to avoid thundering-herd retries. |
| `llm.timeoutMs` | `120000` | LLM call timeout. |
| `llm.circuitBreaker.enabled` | `true` | Per-model circuit breaker. A model that keeps failing with *retryable* errors (429/5xx/network) trips its breaker and is skipped fast (falling back to the next model) until it cools down; non-retryable 4xx/validation errors never trip it. Set `false` to bypass entirely. See [RELIABILITY.md](RELIABILITY.md). |
| `llm.circuitBreaker.failureThreshold` | `5` | Retryable failures within the window needed to open the breaker. |
| `llm.circuitBreaker.cooldownMs` | `30000` | Time the breaker stays open before allowing a trial call (ms). |
| `llm.circuitBreaker.halfOpenSuccesses` | `1` | Successful trial calls needed to close again from half-open. |
| `llm.circuitBreaker.windowMs` | `60000` | Rolling window (ms) over which failures are counted while closed. |

### `router`

| Key | Default | Notes |
| --- | --- | --- |
| `router.enabled` | `true` | Enable model routing. |
| `router.weights.quality` | `1` | Scoring weight. |
| `router.weights.cost` | `0.3` | Scoring weight (lower cost preferred). |
| `router.weights.latency` | `0.2` | Scoring weight (lower latency preferred). |
| `router.rules` | `[]` | Each rule matches by regex/tags → forces a model. |
| `router.fallback` | `[]` | Ordered fallback model ids. |
| `router.useDecisions` | `true` | Let the decision engine pick among top candidates. |
| `router.topK` | `3` | Candidate pool size handed to the decision engine. |

### `budgets`

| Key | Default | Notes |
| --- | --- | --- |
| `budgets.enabled` | `true` | Enforce token/cost budgets. |
| `budgets.adminBypass` | `true` | Admins are not budget-limited. |
| `budgets.rules` | `[]` | Each: `{ user:'*', model:'*', period:'daily'\|'monthly', maxTokens?, maxCost? }`. |

### `decision`

| Key | Default | Notes |
| --- | --- | --- |
| `decision.provider` | `'auto'` | `auto`, `jev`, or `llm`. (`mock` removed from the enum; a mock provider is appended only under `MERCURY_ENABLE_MOCK=1`.) |
| `decision.jev.model` | `'typesafe/jev-1.13'` | Jev model id. |
| `decision.jev.baseUrl` | `'https://openrouter.ai/api/alpha'` | Jev endpoint. |
| `decision.jev.apiKeyEnv` | `'OPENROUTER_API_KEY'` | Env var holding the key. |
| `decision.jev.timeoutMs` | `20000` | Jev call timeout. |
| `decision.llmModel` | `'auto'` | Model used when provider falls back to LLM. |
| `decision.thresholds.injection` | `0.7` | Prompt-injection block threshold. |
| `decision.thresholds.toolApproval` | `0.8` | Auto-approve confidence threshold. |
| `decision.thresholds.triageReview` | `0.8` | Gateway triage review threshold. |
| `decision.thresholds.retry` | `0.6` | Retry-decision threshold. |
| `decision.thresholds.answerQuality` | `0.5` | Reflection answer-quality threshold. |
| `decision.use.*` | all `true` | Toggles: `routing`, `patternSelection`, `toolGate`, `injection`, `triage`, `reflection`. |

### `agent`

| Key | Default | Notes |
| --- | --- | --- |
| `agent.pattern` | `'react'` | Default reasoning pattern. |
| `agent.maxIterations` | `12` | Max reasoning steps per turn. |
| `agent.maxSubagents` | `3` | Max concurrent sub-agents. |
| `agent.maxDepth` | `2` | Max sub-agent nesting depth. |
| `agent.personality` | `'default'` | Personality profile. |
| `agent.temperature` | `0.3` | Sampling temperature. |
| `agent.textReactFallback` | `true` | Use text-based ReAct when native tool calling is unavailable. |
| `agent.nudgeEvery` | `8` | Steps between progress nudges. |
| `agent.compression.threshold` | `0.75` | Context-fraction trigger for compression. |
| `agent.compression.keepLast` | `6` | Recent messages kept verbatim. |
| `agent.toolTimeoutMs` | `60000` | Per-tool execution timeout. |

### `memory`

| Key | Default | Notes |
| --- | --- | --- |
| `memory.memoryCharLimit` | `2200` | Curated MEMORY.md size cap. |
| `memory.userCharLimit` | `1375` | Curated USER.md size cap. |
| `memory.recallK` | `5` | Items recalled per turn. |
| `memory.embeddings.provider` | `'hash'` | `hash`, `openai`, or `ollama`. |
| `memory.embeddings.model` | `'text-embedding-3-small'` | Embedding model (non-hash providers). |
| `memory.embeddings.dims` | `256` | Embedding dimensions. |
| `memory.embeddings.baseUrl` | *(unset)* | Override endpoint. |

### `skills`

| Key | Default | Notes |
| --- | --- | --- |
| `skills.dirs` | `[]` | Extra skill directories. |
| `skills.autoCreate` | `true` | Auto-distil skills from successful runs. |
| `skills.minToolCallsForSkill` | `4` | Minimum tool calls before a run becomes a skill. |
| `skills.distill.enabled` | `false` | **Self-distilling skills (1.2.0)** master switch (distil / match / record). |
| `skills.distill.autoApprove` | `false` | Skip review and mark newly distilled skills approved immediately. |
| `skills.distill.minToolCalls` | `2` | A winning run must have made at least this many tool calls to distil a skill. |
| `skills.distill.matchMinSimilarity` | `0.3` | Min similarity (0..1) to reuse an approved skill for an incoming task. |
| `skills.distill.dedupMinSimilarity` | `0.6` | Min similarity (0..1) to treat a new trace as the same skill (dedup/version). |
| `skills.distill.minRunsBeforeRetire` | `5` | Uses required before a skill is eligible for auto-retire. |
| `skills.distill.retireBelowSuccessRate` | `0.5` | Auto-retire an approved skill below this observed success rate. |
| `skills.distill.maxSkills` | `500` | Hard cap on stored distilled skills (oldest retired pruned beyond it). |

### `replay` (1.2.0)

| Key | Default | Notes |
| --- | --- | --- |
| `replay.enabled` | `true` | Persist a per-run bus-event trace for time-travel replay. |
| `replay.retainTraces` | `1000` | Max run traces retained (oldest pruned beyond it). |
| `replay.persistDeltas` | `false` | Also persist per-step state deltas (larger traces; faster state reconstruction). |

### `evals` (1.3.0)

| Key | Default | Notes |
| --- | --- | --- |
| `evals.enabled` | `true` | Master switch for the eval harness, facade and endpoints (safe: read/score only). |
| `evals.retainScores` | `500` | Max recorded suite scores retained per suite (oldest pruned first). |
| `evals.weights.passRate` | `0.5` | Weight of pass-rate in the aggregate score (normalized internally). |
| `evals.weights.cost` | `0.2` | Weight of the cost-per-task metric. |
| `evals.weights.intervention` | `0.15` | Weight of the intervention-rate metric. |
| `evals.weights.similarity` | `0.15` | Weight of the output-similarity metric. |
| `evals.costCeiling` | `0.05` | Cost ($) treated as worst-acceptable cost-per-task (normalizes the cost metric **and** gates tuning). |
| `evals.autotune.enabled` | `false` | **Governed auto-tuner** master switch (it mutates config — off by default). |
| `evals.autotune.minImprovement` | `0.02` | Minimum absolute score gain (0..1) a proposal must deliver to be accepted. |
| `evals.autotune.maxProposals` | `8` | Max proposals evaluated per tune request (runaway guard). |
| `evals.autotune.autoApply` | `false` | Apply an accepted proposal automatically; when false, applying needs explicit approval. |

### `bundles` (1.3.0)

| Key | Default | Notes |
| --- | --- | --- |
| `bundles.enabled` | `true` | Master switch for export/inspect/install (facade, CLI and endpoints). |
| `bundles.dir` | `''` | Bundle storage directory; empty → `<dataDir>/bundles`. |
| `bundles.signingSecret` | `mercury-bundle-default-key` | HMAC-SHA256 signing secret; **override in production** for authenticity. |
| `bundles.requireSignature` | `true` | Reject a bundle whose signature is missing or does not verify (tamper/compat guard). |
| `bundles.autoApprovePolicy` | `false` | Apply bundled policy-as-code rules immediately instead of queuing for approval. |
| `bundles.autoApproveMcp` | `false` | Apply bundled MCP presets/servers immediately instead of queuing for approval. |

### `memory` governance & knowledge (1.4.0)

| Key | Default | Meaning |
|---|---|---|
| `memory.governance.mode` | `off` | `off` \| `soft` \| `strict`. `strict` enforces namespace allow-lists and PII blocking. |
| `memory.governance.enforcePolicy` | `false` | Route `remember`/`recall`/`forget` through the policy engine (`memory.read`/`memory.write`). |
| `memory.governance.pii.detect` | `true` | Detect PII (email, card, SSN, IP, phone) on write. |
| `memory.governance.pii.redact` | `true` | Replace detected PII with placeholders before storing. |
| `memory.governance.pii.block` | `false` | Reject writes that contain PII (instead of redacting). |
| `memory.retention.ttlDays` | `0` | Prune facts older than N days (0 = keep forever). |
| `memory.retention.maxItemsPerNamespace` | `0` | Max facts kept per namespace; oldest pruned (0 = unbounded). |
| `memory.namespaces.default` | `default` | Namespace used when none is given. |
| `memory.namespaces.allowed` | `[]` | When set (strict), only these namespaces are accepted. |
| `memory.knowledge.enabled` | `false` | Enable the knowledge/RAG store and ground `buildContext()` with it. |
| `memory.knowledge.chunkChars` | `900` | Target characters per knowledge chunk. |
| `memory.knowledge.chunkOverlap` | `120` | Character overlap between consecutive chunks. |
| `memory.knowledge.recallK` | `4` | Default number of knowledge chunks recalled. |

### `teams` (1.4.0)

| Key | Default | Meaning |
|---|---|---|
| `teams.enabled` | `false` | Master switch for the teams module, facade, CLI and endpoints. |
| `teams.maxMembers` | `8` | Maximum members allowed in a team definition. |
| `teams.defaultStrategy` | `coordinator` | `coordinator` \| `pipeline` \| `debate` when a team omits a strategy. |
| `teams.budget` | `0` | Per-run total cost ceiling (0 = no ceiling); members are skipped once hit. |
| `teams.requireApproval` | `false` | Gate every team run behind an approval. |

### `reflection`

| Key | Default | Notes |
| --- | --- | --- |
| `reflection.enabled` | `true` | Enable post-run reflection. |
| `reflection.lessons` | `true` | Record lessons learned. |
| `reflection.userModel` | `true` | Update the per-user model. |

### `learning` (1.1.1)

| Key | Default | Notes |
| --- | --- | --- |
| `learning.enabled` | `false` | Master switch for learning from runs (off by default). |
| `learning.hints.enabled` | `true` | Inject a hint from the most similar past successful run. |
| `learning.hints.maxExamples` | `1` | Past-success examples summarised into the hint. |
| `learning.hints.minSimilarity` | `0.15` | Min token-overlap similarity (0..1) to count as "similar". |
| `learning.hints.lookback` | `50` | Candidate past runs considered (most recent first). |
| `learning.routing.enabled` | `true` | Adjust routing from observed per-(bucket, model) outcomes. |
| `learning.routing.minSamples` | `5` | Min recorded runs for a pair before it influences routing. |
| `learning.routing.minSuccessRate` | `0.5` | A learned model must clear this success rate to be preferred. |
| `learning.playbooks.enabled` | `true` | Persist recurring failure signatures → remediation. |
| `learning.playbooks.minOccurrences` | `2` | Occurrences before a playbook is surfaced. |
| `learning.playbooks.minSimilarity` | `0.2` | Min task similarity (0..1) to surface a playbook. |

### `composition` (1.1.1)

| Key | Default | Notes |
| --- | --- | --- |
| `composition.enabled` | `true` | Enable skill/tool composition (the `skill_compose` tool). |
| `composition.maxDepth` | `5` | Hard max nesting depth of sub-skill invocations (cycle guard). |
| `composition.maxSteps` | `40` | Max steps a single composition may run. |
| `composition.cache.enabled` | `true` | Cache intermediate composition results. |
| `composition.cache.ttlMs` | `300000` | Cache entry TTL (5 min). |
| `composition.cache.maxSize` | `500` | Max cached entries. |

### `workflows` (1.1.1)

| Key | Default | Notes |
| --- | --- | --- |
| `workflows.planner.enabled` | `false` | Auto planner-executor pattern (off; the template is always usable by name). |
| `workflows.planner.minSteps` | `3` | Minimum steps a planned workflow must attempt. |
| `workflows.planner.targetSteps` | `5` | Target number of steps the planner aims for. |
| `workflows.planner.maxSteps` | `12` | Hard cap on steps (runaway guard; also bounded by the workflow budget). |
| `workflows.planner.replanOnFailure` | `true` | Re-plan remaining steps on a failed step instead of stopping. |

### `tools`

| Key | Default | Notes |
| --- | --- | --- |
| `tools.disabled` | `[]` | Globally disabled tool names. |
| `tools.toolsets` | `{}` | Per-toolset overrides. |
| `tools.platforms` | `{}` | `{ <name>: { disabledToolsets[] } }` per gateway platform. |
| `tools.approvals.mode` | `'manual'` | `manual`, `auto`, `smart`, or `deny`. |
| `tools.jail.roots` | `[]` | Allowed filesystem roots (path jail). |
| `tools.jail.allowOutside` | `false` | Allow access outside the jail. |
| `tools.terminal.backend` | `'local'` | `local`, Docker, or SSH. |
| `tools.terminal.dockerImage` | `'node:22-slim'` | Image for the Docker backend. |
| `tools.terminal.ssh` | `{ host?, user?, keyPath? }` | SSH backend target. |
| `tools.terminal.timeoutMs` | `60000` | Terminal command timeout. |
| `tools.web.searchProvider` | `'duckduckgo'` | `duckduckgo`, `searxng`, or `brave`. (`mock` removed.) |
| `tools.web.searxngUrl` | *(unset)* | SearXNG instance URL. |
| `tools.web.allowPrivateNetworks` | `false` | SSRF guard: allow private ranges. |
| `tools.web.maxBytes` | `2000000` | Max fetch size. |
| `tools.web.render` | `false` | `web_read` default backend: `false` = HTTP + HTML extraction; `true` = render via `tools.browser.backend` first. A per-call `render` arg overrides it. |
| `tools.browser.backend` | `'auto'` | Browser automation backend (`auto`/`playwright`/`cdp`/`fetch`); also the backend `web_read` renders through. |
| `tools.browser.cdpUrl` | *(unset)* | Chrome DevTools Protocol URL. |
| `tools.image.provider` | `'openai'` | Image generation provider (was `mock`; throws if `OPENAI_API_KEY` unset). |
| `tools.image.model` | `'dall-e-3'` | Image model. |
| `tools.executeCode.timeoutMs` | `30000` | Code-execution timeout. |
| `tools.executeCode.maxToolCalls` | `50` | Max nested tool calls from executed code. |
| `tools.executeCode.backend` | `'auto'` | `host`, `docker` (no network, no capabilities, read-only) or `auto` (docker when `tools.terminal.backend` is docker). |
| `tools.executeCode.pythonImage` / `nodeImage` | `python:3.12-slim` / `node:22-slim` | Images for the docker backend. |
| `tools.polyglotDirs` | `[]` | Directories scanned for polyglot (multi-language) tools. |

### `mcp`

| Key | Default | Notes |
| --- | --- | --- |
| `mcp.servers` | `{}` | Each: `{ transport:'stdio'\|'http'\|'sse', command?, args[], env{}, url?, headers{}, include[], exclude[], trust:'untrusted', allowSampling:false, enabled:true }`. |
| `mcp.server.enabled` | `true` | Expose Mercury's own MCP server. |
| `mcp.server.path` | `'/mcp'` | MCP endpoint path. |

### `gateway`

| Key | Default | Notes |
| --- | --- | --- |
| `gateway.enabled` | `false` | Enable the messaging gateway. |
| `gateway.continuity` | `'per-user'` | `per-user` or `per-chat` session continuity. |
| `gateway.pairing` | `true` | Require device pairing codes. |
| `gateway.triage` | `false` | Enable inbound triage. |
| `gateway.adapters` | `{}` | Per-adapter configuration. |

### `scheduler`

| Key | Default | Notes |
| --- | --- | --- |
| `scheduler.enabled` | `true` | Enable the scheduler. |
| `scheduler.tickMs` | `30000` | Poll interval. |
| `scheduler.maxRetries` | `2` | Retries per scheduled run. |

### `attachments`

| Key | Default | Notes |
| --- | --- | --- |
| `attachments.maxBytes` | `26214400` (25 MB) | Max attachment size. |
| `attachments.allowedKinds` | `[image, audio, video, document, other]` | Permitted kinds. |
| `attachments.scanCommand` | *(unset)* | Optional external AV/scan command. |

### `voice`

| Key | Default | Notes |
| --- | --- | --- |
| `voice.stt.provider` | `'openai'` | Speech-to-text provider (was `mock`; throws `stt_unconfigured` if `OPENAI_API_KEY` unset). |
| `voice.stt.command` | *(unset)* | External STT command. |
| `voice.stt.model` | `'whisper-1'` | STT model. |
| `voice.tts.provider` | `'openai'` | Text-to-speech provider (was `mock`; throws `tts_unconfigured` if `OPENAI_API_KEY` unset). |
| `voice.tts.command` | *(unset)* | External TTS command. |
| `voice.tts.voice` | `'alloy'` | TTS voice. |
| `voice.wakeWord.command` | *(unset)* | Wake-word detector command. |

### `security`

| Key | Default | Notes |
| --- | --- | --- |
| `security.injection.enabled` | `true` | Prompt-injection detection. |
| `security.injection.blockInput` | `false` | Block (vs. flag) suspicious input. |
| `security.redactSecrets` | `true` | Redact secrets from output. |
| `security.redactPiiInOutput` | `false` | Redact PII from output. |
| `security.audit` | `true` | Enable the hash-chained audit log. |

### `observability`

| Key | Default | Notes |
| --- | --- | --- |
| `observability.recordEvents` | `true` | Persist the event stream. |
| `observability.otlpEndpoint` | *(unset)* | OpenTelemetry OTLP endpoint. |
| `observability.metrics` | `true` | Expose `/metrics`. |

### `wiki`

The LLM-Wiki subsystem (`wiki_*` tools + `mercury wiki` CLI). See [WIKI.md](WIKI.md).

| Key | Default | Notes |
| --- | --- | --- |
| `wiki.enabled` | `true` | Master switch for the Wiki tools and CLI. |
| `wiki.dir` | `''` | Wiki root directory; empty → `<dataDir>/wiki`. |
| `wiki.schemaFile` | `'SCHEMA.md'` | Schema/convention file inside the wiki dir. |
| `wiki.stubMinChars` | `200` | Pages shorter than this (chars) are flagged as stubs by lint. |

### `addins`

The declarative Add-In system — drop tools / personalities / permission profiles into `<dataDir>/addins/` with no source edits. Additive and backward-compatible with the legacy `personalities/`, `tools/` and `plugins/` scans. See [ADDINS.md](ADDINS.md).

| Key | Default | Notes |
| --- | --- | --- |
| `addins.enabled` | `true` | Master switch for discovering add-ins. |
| `addins.dir` | `''` | Add-ins root directory; empty → `<dataDir>/addins`. |

### `permissions`

Per-agent / per-personality permission profiles. The effective policy is the **intersection** (most-restrictive) of the base policy and the active profile — a profile can only further-restrict, never escalate. See [PERMISSIONS.md](PERMISSIONS.md).

| Key | Default | Notes |
| --- | --- | --- |
| `permissions.dir` | `''` | Permission-profiles directory; empty → `<dataDir>/permissions`. |

### `plugins` and `hooks`

| Key | Default | Notes |
| --- | --- | --- |
| `plugins` | `[]` | Plugin specifiers to load. |
| `hooks` | `[]` | Each: `{ event, type:'log'\|'webhook', url? }`. |


---

## Appendix C — Full HTTP API reference

The server is built on Fastify. Unless noted, routes are under the `/api` prefix and require a bearer
token (JWT from login, or an API token with the appropriate scope). SSE streams use `text/event-stream`.
Admin-only routes require the `admin` role.

### Public (no auth)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe. |
| `GET` | `/metrics` | Prometheus metrics (when `observability.metrics`). |
| `GET`/`POST` | `/webhooks/:name` | Inbound webhooks (gateway/hooks). |
| `GET` | `/*` | SPA fallback (web UI). |

### Auth

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Register (when `auth.allowRegistration`). |
| `POST` | `/api/auth/login` | Log in, returns a JWT. |
| `GET` | `/api/auth/me` | Current user. |
| `PATCH` | `/api/auth/me` | Update current user. |
| `GET` | `/api/auth/status` | Auth/registration status. |

### Chat, sessions, runs, events

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Send a turn (JSON response or SSE stream). |
| `GET`/`POST` | `/api/sessions` | List / create sessions. |
| `GET`/`PATCH`/`DELETE` | `/api/sessions/:id` | Get / rename / delete a session. |
| `GET` | `/api/runs` | List runs. |
| `GET` | `/api/runs/:id/events` | Events for a run. |
| `POST` | `/api/runs/:id/feedback` | Submit feedback on a run. |
| `POST` | `/api/runs/:id/stop` | Abort a running turn. |
| `GET` | `/api/events` | Global event stream. |
| `GET` | `/api/decisions` | Decision-engine records. |
| `POST` | `/api/decisions/try` | Dry-run a decision. |
| `GET` | `/api/reflections` | Reflection records. |
| `GET` | `/api/commands` | Available slash commands. |
| `GET` | `/api/help` | Help index. |
| `GET` | `/api/i18n`, `/api/i18n/:locale` | i18n bundles. |
| `GET`/`POST` | `/api/settings` | Read / update runtime settings. |

### Memory

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/memory` | List / add memory items. |
| `DELETE` | `/api/memory/:id` | Delete a memory item. |
| `PUT` | `/api/memory/curated/:which` | Replace curated MEMORY.md / USER.md. |

### Skills, tools, models

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/skills` | List skills. |
| `GET` | `/api/skills/:name` | View a skill. |
| `POST` | `/api/skills` | Create a skill. |
| `PUT` | `/api/skills/:name` | Update a skill. |
| `GET` | `/api/tools` | List tools. |
| `POST` | `/api/tools/:name/run` | Run a tool directly. |
| `POST` | `/api/tools/toggle` | Enable/disable a tool. |
| `GET` | `/api/models` | List models. |
| `POST` | `/api/models/route` | Ask the router to pick a model. |

### Learning (1.1.1)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/learning` | Status, config flags, auto-tuned route stats and failure playbooks (scope `audit.read`). |
| `GET` | `/api/learning/stats` | Observed routing success rates; optional `?bucket` (scope `audit.read`). |
| `GET` | `/api/learning/playbooks` | Recorded failure playbooks; optional `?limit` (scope `audit.read`). |
| `GET` | `/api/learning/hint` | Preview the hint for a task; `?task` required (any authenticated user). |

### Workflows, schedules

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/workflows` | List / create workflows. |
| `POST` | `/api/workflows/:name/run` | Run a workflow. |
| `GET`/`POST` | `/api/schedules` | List / create schedules. |
| `GET` | `/api/schedules/:id/history` | Run history for a schedule. |
| `PATCH`/`DELETE` | `/api/schedules/:id` | Update / delete a schedule. |
| `POST` | `/api/schedules/:id/:action` | Pause / resume / run now. |

### Attachments, voice, debug

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/attachments` | Upload an attachment. |
| `GET` | `/api/attachments/:id` | Download an attachment. |
| `POST` | `/api/voice/speak` | TTS. |
| `POST` | `/api/voice/transcribe` | STT. |
| `GET` | `/api/debug` | Debug state. |
| `POST` | `/api/debug/breakpoints` | Set breakpoints. |
| `POST` | `/api/debug/resume/:id` | Resume from a breakpoint. |

### Gateway, approvals, audit (admin)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/gateway` | Gateway status. |
| `POST` | `/api/gateway/pair/:code` | Confirm a pairing code. |
| `POST` | `/api/gateway/review/:id` | Resolve a triage review. |
| `GET` | `/api/approvals` | Pending tool approvals. |
| `POST` | `/api/approvals/:id` | Approve / deny. |
| `GET` | `/api/audit` | Hash-chained audit log; optional `actor`, `action` (exact or dotted prefix), `target`, `since`, `until`, `limit`, `offset` filters, returns `{ entries, total, integrity }`. |

### Users, tokens, budgets (admin)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/users` | List / create users. |
| `PATCH`/`DELETE` | `/api/users/:id` | Update / delete a user. |
| `GET`/`POST` | `/api/tokens` | List / create API tokens. |
| `DELETE` | `/api/tokens/:id` | Revoke a token. |
| `GET`/`POST` | `/api/budgets` | List / create budget rules. |
| `DELETE` | `/api/budgets/:id` | Delete a budget rule. |

### MCP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/mcp` | List / add MCP servers. |
| `DELETE` | `/api/mcp/:name` | Remove an MCP server. |
| `*` | `/mcp` | Streamable-HTTP MCP endpoint (bearer token, `mcp` scope). |

---

## Appendix D — Data directory layout

By default Mercury stores everything under `~/.mercury` (override with the `MERCURY_HOME` environment
variable or the `dataDir` config key). The layout:

```
~/.mercury/
├── config.yaml              # main configuration (Appendix B)
├── .env                     # environment overrides loaded at startup
├── mercury.db               # SQLite database (node:sqlite) with FTS5 full-text search
├── secret.key               # JWT signing key, mode 0600 — never commit or share
├── mcp.json                 # MCP server definitions (hot-reloaded)
├── users/
│   └── <userId>/
│       ├── MEMORY.md         # curated long-term memory
│       └── USER.md           # per-user model / profile
├── attachments/             # uploaded files
├── skills/                  # installed/distilled skills
├── tools/                   # custom + polyglot tools
├── workflows/               # workflow definitions
├── plugins/                 # plugins
├── adapters/                # gateway adapters
├── personalities/           # personality profiles
├── patterns/                # custom reasoning patterns
└── checkpoints/
    └── <sessionId>/<n>/      # session checkpoints for replay/rewind
```

Backup = copy the whole directory (stop the server first, or use a SQLite-aware snapshot for
`mercury.db`). The database requires **Node ≥ 22.5** for the built-in `node:sqlite` module.

---

## Appendix E — Troubleshooting & `mercury doctor`

Run `mercury doctor` first — it checks the Node version, the data directory, the config file, configured
providers, and provider keys, and reports what is missing.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `node:sqlite` not found / DB won't open | Node older than 22.5 | Upgrade Node to ≥ 22.5. |
| Agent can't answer, "no provider" | No LLM provider configured/enabled | Run `mercury setup`, or set a provider key env var (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `CHATLLM_API_KEY`) — matching providers auto-enable. |
| `esbuild` postinstall warning | Pre-approved via `allowScripts` in `package.json`; may still appear on older npm | Benign — ignore. |
| "ExperimentalWarning: SQLite is an experimental feature" | Expected with `node:sqlite` | Ignore (or set `NODE_NO_WARNINGS=1`). |
| Want to try it with no real provider | — | Set `MERCURY_ENABLE_MOCK=1` to enable the mock LLM. |
| Port already in use | Another process on 3000 | `serve --port <n>` or free the port. |
| Changes to `mcp.json` not picked up | — | It is hot-reloaded; check the file is valid JSON and the server logs. |

> Honest-status note: the mock LLM and the full offline path are exercised by the test suite
> (185 tests passing). Real external integrations — live LLM providers, the Jev API, chat-platform
> adapters, STT/TTS engines, Docker/SSH terminal backends, `install.sh`, systemd deployment and
> `update` — have **not** been validated end-to-end against live services in this repository.

---

## Appendix F — Glossary

| Term | Meaning |
| --- | --- |
| **Jev** | A typed decision/judgment model (`typesafe/jev-1.13`) used by the decision engine to make small structured choices (routing, tool gating, triage, reflection) instead of a general LLM. |
| **Pattern** | A reasoning strategy for a turn: `react`, `cot`, `plan-execute`, `reflexion`, `tot`, `self-consistency`, `critic`. |
| **Toolset** | A named group of tools that can be enabled/disabled together, including per gateway platform. |
| **Skill** | Procedural memory: a reusable, progressively disclosed how-to distilled from successful runs or installed manually. |
| **Adapter** | A gateway connector to a messaging platform (telegram, discord, slack, whatsapp, signal, matrix, mattermost, teams, irc, email, sms, homeassistant, rss, webhook, webchat, cli). |
| **Gateway** | The subsystem that bridges external messaging platforms to the agent. |
| **Pairing code** | A short code used to authorise (pair) an external chat/device with a Mercury user. |
| **Spotlighting** | Marking external/untrusted content so the model treats it as data, not instructions. |
| **Path jail** | A filesystem sandbox limiting tool access to configured roots. |
| **SSRF guard** | The web-fetch protection that blocks requests to private network ranges by default. |
| **Budget** | A per-user/per-model token or cost limit, enforced per day or month. |
| **Reflection** | Post-run self-evaluation that records lessons and updates the user model. |
| **Continuity** | How gateway sessions are grouped: `per-user` or `per-chat`. |
| **MCP** | Model Context Protocol — Mercury is both an MCP client (consuming external servers) and an MCP server (exposing its own tools). |
| **Polyglot tool** | A tool implemented in another language (Python, Go, C++, Java, JS) via the polyglot protocol. |
| **Blackboard** | A shared memory space used by multi-agent workflows to coordinate. |
| **Checkpoint** | A saved session state enabling replay and rewind. |
| **Canary** | A planted marker used to detect prompt-injection / data exfiltration attempts. |

---

*End of the Full Guide to Mercury.*
