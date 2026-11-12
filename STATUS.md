# Mercury — Build Status (honest snapshot, 2026-11-12)

**Overall:** all 7 packages compile. From a clean build, `npm install && npm run build && npm test`
passes (5 files, **44/44 tests**, offline). `npx eslint .` exits 0. The CLI, HTTP server and web UI
run end-to-end with the offline mock LLM and mock decision provider. Nothing has been exercised
against a real external service: no real LLM API, no Jev API, no chat platform, no STT/TTS service.

## 1. Fully implemented and tested

Tested here means covered by the vitest suite (`tests/`) and/or run by hand in this environment.

| Area | Evidence |
|---|---|
| Agent loop (mock LLM) | tests: plain answer + session persistence, tool call fed back, streaming deltas + run events, slash commands (/new /usage /undo /help), multi-turn continuity |
| Tools | tests: built-in catalogue registered, safe tool runs, polyglot **Python** and **JavaScript** tools run, disabling a tool |
| Memory | tests: facts remember/recall/forget per user, curated MEMORY.md / USER.md |
| Router & budgets | tests: routes to configured model, explicit model honoured, token budget blocks a user |
| Scheduler | tests: natural-language + cron parsing; create/pause/resume/run/delete |
| Workflows & skills | tests: bundled specs/templates load, pipeline workflow with subagents, debate workflow, list/create skills |
| Auth & RBAC | tests: first user admin, JWT login, bad password rejected, role policies, scoped API tokens + revocation |
| Guardrails / prompt injection | tests: heuristic detection vs benign text, untrusted input blocked (authenticated user only warned), spotlight markers, secret redaction + canary leak detection, dangerous shell commands, path jail, webhook HMAC |
| Jev decision provider | tests with **mocked HTTP**: request/answer parsing, retry on transient errors, fail fast on 4xx, fallback chain to next provider |
| MCP | tests: in-memory client↔server roundtrip (list + call `mercury_calculator`), HTTP `/mcp` initialize only with `mcp` scope |
| Gateway | tests: webhook signature rejection, pairing code for unknown user → admin approval → identity linked → conversation continues; Telegram adapter (MockTransport) polls, transcribes a voice memo (mock STT), replies; Slack bad signature rejected |
| HTTP server | tests: health + UI, first user admin/second user, auth + admin-only routes, chat JSON + SSE, attachment upload, management lists, `/metrics` |
| CLI (manual) | `mercury chat "hello"` → `Echo: hello` (exit 0); `chat 'call:calculator {"expression":"6*7"}'` → 42; `help`, `doctor`, `skills list`, `workflow list`, `tools list`, `plugins` |
| Plugins (manual) | the hello plugin from docs/EXTENDING.md loaded from `$MERCURY_HOME/plugins` and its tool was called through `mercury chat` |
| Web UI (manual, browser) | register/login, streaming chat with markdown + usage + feedback, all 15 panels render without errors, German locale, dark theme; served through the preview URL (HTTP 200) |
| Server (manual) | started on port 3000; `/health`, SSE chat with tool call through the public preview URL, `/metrics` |

## 2. Implemented but untested against real external services

These areas have code that compiles. In most cases it also has mock-based tests. None of it has run against the real service:

- **LLM providers:** OpenAI-compatible (incl. Ollama/OpenRouter) and Anthropic, including streaming and tool calling against real APIs.
- **Jev decisions:** the real OpenRouter API (`typesafe/jev-1.13`). The request/response format follows the integration notes and was tested only with mocked HTTP.
- **Gateway adapters:** all 16 against real platforms (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Teams, IRC, Email IMAP/SMTP, SMS/Twilio, Home Assistant, RSS, webhook, webchat, CLI). Telegram, Slack and webhook only ran through mock transports.
- **Voice:** real STT/TTS (OpenAI, whisper, edge-tts, piper, command). Only the mock providers were exercised; the browser mic was not recorded with real audio.
- **MCP client:** connections to external MCP servers (stdio/HTTP/SSE) and sampling.
- **Terminal backends:** Docker and SSH. **Browser backend:** Playwright (fetch backend only).
- **Web search providers:** DuckDuckGo, SearXNG, Brave. Image generation providers.
- **Go polyglot tool** (`tools/hash_go`): no Go toolchain is installed here.
- **Deployment:**
  - `Dockerfile` / `docker-compose.yml`: the docker CLI exists, but there is no daemon, so the image build failed to connect and the build was never run.
  - `deploy/mercury.service`, `install.sh` and `.github/workflows/ci.yml` have not been run.
- **`mercury update`**, `skills install <git-url>` and `import-agent` from a real Hermes install.

## 3. Limitations

- **Mock model:** the mock LLM echoes text and only calls tools on explicit `call:<tool> {json}` syntax. Real agent quality depends on the configured model.
- **Prompt injection:** the guardrails are heuristics plus a classifier. They reduce prompt-injection risk but cannot eliminate it.
- **Audit log:** it records registration, user updates and config changes only. Logins, token changes and approvals are not audited yet.
- **Server scale:**
  - Single process with SQLite (`node:sqlite`, still marked experimental in Node 22). No horizontal scaling.
  - The rate limiter is in-memory.
- **Feature parity:** Hermes parity covers features, not behaviour. Many features have only smoke-level test depth.
- **Locales:** the UI ships English and German. Help docs are English only.
- **Lint:** ESLint reports no problems, but `no-explicit-any` is switched off and short-circuit/ternary expression statements are allowed.
- **Test runner:** `npm install` warns that esbuild's postinstall script was not approved. Tests run fine regardless.
