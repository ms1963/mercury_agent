# Mercury — Build Status (honest snapshot, 2026-11-18)

**Overall:** all 7 packages compile. From a clean build, `npm install && npm run build && npm test`
passes (16 files, **195/195 tests**, offline). `npx eslint .` exits 0. The CLI, HTTP server and web UI
run end-to-end with the offline mock LLM and mock decision provider. Nothing has been exercised
against a real external service: no real LLM API, no Jev API, no chat platform, no STT/TTS service.

## 1. Fully implemented and tested

Tested here means covered by the vitest suite (`tests/`) and/or run by hand in this environment.

| Area | Evidence |
|---|---|
| Agent loop (mock LLM) | tests: plain answer + session persistence, tool call fed back, streaming deltas + run events, slash commands (/new /usage /undo /help), multi-turn continuity |
| Tools | tests: built-in catalogue registered, safe tool runs, polyglot **Python** and **JavaScript** tools run, disabling a tool |
| Memory | tests: facts remember/recall/forget per user, curated MEMORY.md / USER.md |
| Router & budgets | tests: routes to configured model, explicit model honoured, token budget blocks a user, router tag inference (code/reasoning/writing/fast) |
| Resilience (retries) | tests: jittered exponential-backoff math with injectable RNG; a **retryable** provider error is retried on the same model and recovers (emitting `llm.retry`); a **non-retryable** error fails fast without retrying. Fault injected via the mock provider's scripted-response queue |
| Reliability & efficiency patterns | tests (`tests/reliability.test.ts`, 36, offline + deterministic via injectable clocks/RNG): **CircuitBreaker** state machine (opens at threshold, fast-rejects with `CircuitOpenError` while open, OPEN→HALF_OPEN after cooldown, HALF_OPEN→CLOSED after successes, re-opens on a half-open failure, rolling-window pruning, non-failure predicate ignored, `onStateChange` events, `reset()`, `resetTimeoutMs` alias, `CircuitOpenError` name/`retryAfterMs`/code/503 metadata, `halfOpenMaxConcurrent` trial saturation); **Saga** success + reverse-order compensation, per-step result passed to compensate, compensation errors collected without masking the original, `onEvent` lifecycle phases, named-saga error message; **TtlCache** TTL expiry, per-entry override, LRU eviction, `wrap` memoizer, `delete`/`clear`, lazy expiry purge via `size`; **SingleFlight** concurrent-call dedup + key release **and shared-rejection error propagation**; **retry** wrapper (reuses `backoffDelay`, aborts on an aborted signal). Wired into `LLMService` as one breaker per model (only `ProviderError.retryable` trips it); declarative `llm.circuitBreaker.*` config keys (default on). See [docs/RELIABILITY.md](docs/RELIABILITY.md) |
| LLM Wiki (ingestion-time synthesis) | tests (`tests/wiki.test.ts`, 19, offline + deterministic via a test-local fake LLM): `init` seeds the layout; `ingest` stores the source read-only, writes a page, updates index + log, records `synthesized`, **re-ingest updates the page and accumulates its sources**, **file-path ingest** (not just literal text) with a read-only copy, **unique raw-name de-duplication**, missing-file rejection; `query` answers and cites raw sources, returns a "no pages" answer on an empty wiki, rejects an empty question, and **coalesces identical concurrent queries into one `answer()` call**; `status` reports uninitialized→page/source counts; every **deterministic** lint check (orphan, broken-link, stub, stale) and **delta** mode run with **no LLM**; the contradiction check runs with an injected fake LLM and is verified skipped under `no_llm`. Runtime wires the real `LLMService` (inherits circuit-breaker + retry); no mock in any runtime path. CLI `mercury wiki init\|status\|ingest\|query\|lint [--delta] [--no-llm]`; tools `wiki_ingest` / `wiki_query` / `wiki_lint`. See [docs/WIKI.md](docs/WIKI.md). **Untested:** synthesis/answer/contradiction quality against a real LLM API (see §2) |
| Add-Ins & permission profiles | tests (`tests/addins.test.ts` 13 + `tests/permissions.test.ts` 16, offline + deterministic, temp dirs): the **add-in loader** (valid manifest contributes personalities + polyglot tool dirs + permission profiles; `enabled:false` contributes nothing; malformed manifest skipped with a warning and never throws; **path-traversal guard** rejects `../` personality/tool paths; missing personality file + tool dir without `tool.json` warned; non-directory entries ignored; aggregated permission profiles; duplicate-name guard; legacy coexistence); the **permission-profile loader** (single-policy and name→policy files; invalid skipped); the **scaffold** (writes a loadable add-in; rejects bad names / overwrite); the **`effectivePolicy` merge** (profile restricts a user-allowed tool; cannot escalate a user-denied tool; `maxToolRisk` min; deny-list union; allow-list intersection incl. **glob patterns**) end-to-end through `PolicyEngine` for **`tool.use`, `model.use` and `workflow.run`**, plus **API-token scope** enforcement and admin bypass. CLI `mercury addin list|scaffold` and `mercury perms list|show` smoke-run by hand. Runtime discovers add-ins + profiles at start (pure FS+parse, no mocks). See [docs/ADDINS.md](docs/ADDINS.md), [docs/PERMISSIONS.md](docs/PERMISSIONS.md). **Untested:** execution of a scaffolded polyglot tool depends on the interpreter being installed |
| Cost/token accounting | tests: `costOf` math (per-1M-token input/output rates; 0 when no model profile); per-run token/cost totals aggregated from `llm.response` events |
| Self-eval harness | tests: pure `scoreTask` scoring (pass/partial/notContains/regex/error), tag-filtered `selectEvals`, and an **end-to-end run of the built-in suite (5/5 tasks pass)** through the real agent loop on the mock LLM. CLI: `mercury eval [--tag <t>] [--json]` run by hand → 5/5 passed |
| Scheduler | tests: natural-language + cron parsing; create/pause/resume/run/delete |
| Workflows & skills | tests: bundled specs/templates load, pipeline workflow with subagents, debate workflow, list/create skills |
| Auth & RBAC | tests: first user admin, JWT login, bad password rejected, role policies, scoped API tokens + revocation |
| Audit log (auth/authz events) | tests (`tests/audit.test.ts`, 20): successful login (`auth.login`) and each failure branch (`auth.login_failed` with reason `unknown_user` / `bad_password` / `account_disabled`, attempted password never stored), token issue/revoke (`token.issue` / `token.revoke`, no double-log on repeat revoke), pairing approve/reject (`pairing.approve` / `pairing.reject`), filtered+paginated `AuditLog.query` (exact + dotted-prefix action match, actor filter, `since` window, `total`, limit clamping), and tamper-evident chain `verify()`; user lifecycle (`user.register` / `user.update` / `user.delete`) audited at the service layer so CLI admin ops are captured too, each with the operating principal. Server test: `GET /api/audit` is admin-only (403 for a plain user) and honours `?action=` filters |
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
- **LLM Wiki against a real model:** page synthesis, grounded answering and contradiction detection call the real `LLMService`, but their output quality has only been exercised with a test-local fake LLM. The model-output JSON parsing is defensive; real-model page/answer quality is unmeasured here.
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
- **Audit log coverage:** registration, user updates, config changes, logins (success + failure),
  token issuance/revocation and gateway pairing approvals/rejections are now audited. Mercury has no
  token-*edit* operation, so "token changes" covers issue and revoke only (not an in-place mutation).
- **Server scale:** single process; no cross-host horizontal scaling (that would need an external shared store such as Postgres/Redis). Persistence uses `node:sqlite`, which Node 22 still marks experimental. The rate limiter is now backed by that SQLite database (`rate_limits` table), so its counters survive restarts and are shared across all requests in the process — but, like the rest of the store, it is single-process-shared, not cross-host.
- **Feature parity:** Hermes parity covers features, not behaviour. Many features have only smoke-level test depth.
- **Locales:** the UI ships English and German, and the help docs now ship English and German too — the German help docs are served when the effective locale is `de` (via `config.locale`), with the English docs as fallback for any topic without a translation.
- **Lint:** `npx eslint .` exits 0 with the rules hardened — `@typescript-eslint/no-explicit-any` is `error` and `no-unused-expressions` allows no short-circuit or ternary statements. The only `any` left is a single, commented `eslint-disable` on the existential `AnyTool` container type (heterogeneous tool registry), which TypeScript cannot express without `any`.
