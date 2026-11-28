# Mercury — Build Status (honest snapshot, 2026-11-28, through v2.2.1)

**Overall:** all 8 packages compile. From a clean build, `npm install && npm run build && npm test`
passes (**60 files, 1060 passed / 2 skipped**, offline — up from 549 at v1.8.0 as the v1.9.0 through v2.2.1
subsystems landed with their own offline suites). The v1.4.0 subsystems — multi-agent teams/orchestration
and the governed long-term memory & knowledge/RAG layer — are covered by the offline suite
(`tests/teams.test.ts`, `tests/memory.test.ts`). `npx eslint .` exits 0. The CLI, HTTP server and web UI
run end-to-end with the offline mock LLM and mock decision provider. **The core agent loop has now
also been exercised against real LLMs** — see §0. The Jev API and chat platforms remain offline/mock-only.
(Note: one test, `security-gaps-residual.test.ts` SC-24, fails **only on the live deployment host**
because that host carries an untracked `deploy/<host>.conf` nginx vhost; the repository ships no such
file, so CI is green — the latest CI run passes build & test on node 22 and node 24 plus the
docker image build.)

## 0d. New in v2.2.1 — hands-free voice mode in the web chat (offline-tested)

- **What it is.** The web Chat panel gained a ChatLLM-style voice layer: read-aloud of assistant replies
  (🔊/🔇, `localStorage` `mercury.voice.autospeak`), a hands-free microphone (browser-native
  `SpeechRecognition` first, with `MediaRecorder` → `POST /api/voice/transcribe` (Whisper) as fallback),
  and optional auto-send of a finished utterance (🗣/🖐, `localStorage` `mercury.voice.autosend`). **All
  three toggles are OFF by default.** Speech language follows the UI locale (de → `de-DE`, else `en-US`);
  the manual per-message 🔊 button is retained.
- **Code.** Pure/injectable helpers in `packages/server/public/js/voice.js` (markdown→speakable-text
  stripper, language/voice resolution, capability/fallback selection), consumed by
  `packages/server/public/js/chat.js`; styles in `packages/server/public/styles.css`; EN+DE i18n keys
  (`chat.readAloud*`, `chat.listening`, `chat.autoSend*`) at full parity. Server fallbacks: Whisper
  (`/api/voice/transcribe`) and Piper (`/api/voice/speak`).
- **Tested.** 23 offline unit tests in `tests/voice-web.test.ts` using fake browser globals (no real
  mic/speaker/DOM). **NOT CI-verified:** the DOM wiring in `chat.js`, live microphone capture and real
  `speechSynthesis` playback; browser-support varies (Firefox/older Safari lack `SpeechRecognition`). See
  `docs/GAPS.md` §2c.

## 0b. New in v2.1.0 — complete EN/DE internationalization (offline-tested)

- **Full English + German coverage.** Every `docs/help/` topic now has a German counterpart under
  `docs/help/de/` (42 each, in sync, incl. new `fallback`/`route` topics), and the shared UI/CLI message
  catalogs `locales/en.json` / `locales/de.json` are at full key parity (475 keys each). A `resolveLocale()`
  helper honours `MERCURY_LANG`/`MERCURY_LOCALE`/`config.locale` (default English), and the
  `fallback`/`route`/`hooks` command output is routed through the catalog so it localizes. Covered by
  `tests/i18n.test.ts` (resolver, help-topic parity, catalog key parity). Version bumped to 2.1.0.

## 0a. New in v2.2.0 — self-extending tools / dynamic tool synthesis (offline-tested, DISABLED by default)

- **What it is.** Mercury can DRAFT a new tool when a capability is repeatedly missed. It is a Mercury-only
  extra and HIGH-RISK, so it is **disabled by default** behind `selfExtension.enabled = false` — a hard,
  localized no-op on CLI/Web/API while off.
- **Pipeline (gated at every step).** `tool.miss` event → threshold gap detection (`missThreshold`, default
  3) → LLM authoring of a draft (impl + generated unit test + least-privilege capability manifest) →
  validation BEFORE registration (manifest deny-by-default → compile → generated unit test, out-of-process,
  never `eval`) → approval gating (PENDING until approved; `autoApprove` opt-in) → sandboxed out-of-process
  execution as a persisted polyglot tool folder (scrubbed env, no network unless declared, time/output caps)
  → provenance + audit → persistence across sessions.
- **Surfaces.** `mercury selfextend status|enable|disable|list|gaps|synthesize|approve|deny` (`--json`); Web
  UI **Self-Extend** admin panel; API `GET /api/selfextend`, `POST /api/selfextend/toggle`,
  `POST /api/selfextend/:id/approve|deny`. New `selfExtension.*` config; EN+DE help + full EN/DE i18n.
- **Code.** Pure/injectable logic in `packages/core/src/synthesis/*`; real out-of-process compile/test
  runners in `packages/tools/src/synthesis/runners.ts`; runtime wiring in `packages/runtime/src/mercury.ts`.
  Covered by `tests/synthesis.test.ts` (stubbed LLM + real local compile/test runners).
- **Honesty note.** Infrastructure implemented and offline-tested. NOT CI-verified: real production-LLM
  draft quality, and execution inside the full polyglot/Docker host sandbox (CI exercises the lighter host
  child-process compile/test path). Treat real-LLM authoring and production-sandbox execution as
  experimental. See `docs/GAPS.md` §2b for the threat model.

## 0c. New since v1.8.0 — v1.9.0 and v2.0.0 subsystems (offline-tested)

These subsystems shipped after the v1.8.0 snapshot above and are each covered by the offline vitest
suite. Like the rest of §1, "tested" means offline/deterministic coverage, not validation against real
external editors/clients:

- **v1.9.0 — Plugin lifecycle (`mercury plugins install|update|remove|list`)** — install from a local
  path or git URL with install-manifest tracking, update via git pull / re-copy, gated removal; covered
  by `tests/plugins-manage.test.ts`.
- **v1.9.0 — Agent Client Protocol server (`mercury acp serve`)** — ACP over stdio (newline-delimited
  JSON-RPC 2.0) exposing the same agent + tool surface as the MCP server to editors/IDEs; covered by
  `tests/acp.test.ts`.
- **v1.9.0 — Insights (`mercury insights`)** — usage/cost/latency rollups over the runs table; covered
  by `tests/insights.test.ts`.
- **v1.9.0 — Memory graph & journey timeline (`mercury memory-graph`, `mercury journey`)** — graph and
  chronological views over stored memory; covered by `tests/memgraph.test.ts`.
- **v2.0.0 — Shell-script lifecycle hooks (`mercury hooks list|events|add|remove|run`)** — run a
  configured shell command at real lifecycle events, routed through the existing approvals layer before
  the command is spawned; 35 offline tests in `tests/hooks.test.ts`.
- **v2.0.0 — Language Server Protocol server (`mercury lsp serve`)** — LSP over stdio (JSON-RPC 2.0 with
  Content-Length framing) exposing the same agent + tool surface to LSP-capable editors; 47 offline
  tests in `tests/lsp.test.ts`.
- **v2.0.0 — Operator conveniences (`mercury completion|logs|prompt-size|migrate|console`)** —
  shell-completion generation, read-only log views over the runs table, assembled-prompt size report,
  migration status/apply over the existing runner, and an operator REPL banner; covered by
  `tests/operator.test.ts`. **Untested live:** these are exercised offline only; the LSP/ACP servers
  have not been driven by a real editor/IDE client (see §2).

## 0a. Document/spreadsheet generation + voice, verified end-to-end (2026-11-23, v1.6.0)

The v1.6.0 generation and media tools were driven **through their real handlers** (offline, no public
server) and produced valid files, each returned as an attachment exactly as the live agent would:

- **`document_generate`** → real `e2e.docx` (valid OOXML, `word/document.xml`), `e2e.pptx`
  (`ppt/presentation.xml`), `e2e.pdf` (`%PDF`, via libreoffice), `e2e.html`, `e2e.md` — all from the
  host `pandoc`/`libreoffice`.
- **`spreadsheet_generate`** → real `e2e.xlsx` (valid OOXML, `xl/workbook.xml`) from JSON rows, via the
  host `zip`.
- **`text_to_speech`** → real `speech.wav` (RIFF/WAVE, 16-bit PCM) through a real `VoiceService` on the
  offline **piper** provider — proving text-in → audio-file-out as an attachment.
- **OOXML extraction round-trip** — the generated docx/pptx/xlsx fed back through `extractText` are
  classified as `document`, MIME-sniffed, and text-extracted correctly (xlsx numeric cells correctly
  stay out of the text layer by design).
- **`image_generate`** — implemented and registered, but hardwired to the OpenAI image API
  (needs `OPENAI_API_KEY`); **no offline provider**, so it was **not** exercised live. Verified by code
  and registration only.

## 0. Live test against real LLMs (2026-11-23)

The core agent loop was run against **real LLMs** via the Abacus **RouteLLM** endpoint
(`https://routellm.abacus.ai/v1`, the built-in OpenAI-compatible `chatllm` provider), with no mock
(`MERCURY_ENABLE_MOCK` unset). Models exercised: `chatllm/route-llm`, `chatllm/gpt-5.5` and
`chatllm/claude-sonnet-5`. These were real, billed, non-deterministic calls. What was verified
end-to-end against the live models:

- **Agent loop + tool execution** — multi-turn runs that wrote files (`write_file`) and ran them
  (`terminal`), returning correct real output (e.g. prime/square/factorial/Fibonacci scripts).
- **Self-distilling skills** — booting the runtime with services on (`startServices: true`, the path
  `mercury serve` uses), a novel successful run **auto-distilled** an approved skill
  (`auto-write-python-file-tmp`: generalized `write_file → terminal` with `{path}`/`{content}`/
  `{command}`/`{timeout_s}` params); subsequent similar runs **matched and reused** it (uses=5,
  successes=5) instead of re-distilling.
- **Routing-learning stats** — `learning_route_stats` populated per (difficulty bucket, model) from
  real outcomes: for the same `low` bucket at 100% success, gpt-5.5 cost ~20× less than
  claude-sonnet-5 (6.7k vs 43.7k tokens). This is real learned cost/success data the router can act on.
- **Experience hints** — `learn hints` returns a real hint distilled from a prior successful run.
- **Reflection, memory writes, token/cost accounting** — all recorded from the live runs.

**Note on one-shot mode.** The CLI `chat` command boots with services **off**
(`bin.ts` sets `startServices` true only for `serve` / `mcp serve`), and `mercury.ts` returns before
attaching the background `run.end` subscribers when `services === false`. So auto-distillation and
routing-learning accumulate under `mercury serve` (or an equivalent services-on process), **not** in
one-shot `mercury chat`. The subsystems themselves are functional, as proven above.

**Still NOT exercised against real services** (see §2): the Jev decision engine, real chat-platform
adapters, real STT/TTS/voice, external MCP servers, Docker/SSH terminal backends, the Playwright
browser backend, web-search/image-gen providers, the deployment scripts, and LLM Wiki
synthesis/answer/contradiction **quality** against a real model.

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
| Scheduler | tests: natural-language + cron parsing; create/pause/resume/run/delete. Edit/update supported via `scheduler.update()`, `PATCH /api/schedules/:id`, CLI `schedule edit` and the web Scheduler panel's inline editor (change when/name/task/delivery/retries; CLI edit path not yet covered by an automated test) |
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

These areas have code that compiles. In most cases it also has mock-based tests. Except where §0 notes it was exercised live, none of it has run against the real service:

- **LLM providers:** the **OpenAI-compatible** provider **has** been exercised against a real API — the Abacus RouteLLM endpoint via the built-in `chatllm` provider, including real tool-calling (see §0). Streaming against a real API, and the **Anthropic**, **Ollama**, **LM Studio** and direct **OpenAI/OpenRouter** providers, remain unexercised live.
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
