# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-11-20

### Added
- **Edit existing schedules — change the task, the time (`when`), the name, delivery or retry
  limit of a schedule you already created**, from both front-ends (the backend `scheduler.update()`
  and `PATCH /api/schedules/:id` already supported this; these changes expose it):
  - **CLI:** new `mercury schedule edit <id>` (alias `update`) subcommand. Pass any subset of
    `--when "..."`, `--name "..."`, `--task "..."` (task text can also be trailing words after the
    id), `--deliver platform:target`, `--max-retries N`. At least one field is required. Changing
    `--when` recomputes and prints the next run time.
  - **Web UI:** each row in the Scheduler panel has an **Edit** button that opens an inline editor
    with Name / When / Task prefilled; Save issues the `PATCH` and reloads the list.

### Changed
- **Scheduler "Run now" gives visible feedback in the web UI** — triggering a manual run now shows a
  toast and opens the schedule's History (which lists the new "running" entry), instead of appearing
  to do nothing.

### Fixed
- **Manual schedule runs are fire-and-forget on the server** — `POST /api/schedules/:id/run` returns
  immediately and the run executes in the background, so the request no longer blocks (previously the
  web "Run now" could appear frozen until the agent finished).
- **`web_search` tool falls back to the DuckDuckGo lite endpoint** when the primary HTML endpoint is
  rate-limited, and surfaces a clear rate-limit error instead of returning empty results.

## [0.6.0] - 2026-11-19

### Added
- **Named voice presets — swap the STT/TTS solution (offline or online) with one command.**
  Building on the swappable `SttPort` / `TtsPort` layer from 0.5.0, a new preset catalogue
  (`packages/core/src/voice/presets.ts`) ships ready-made, schema-validated configuration blocks
  for the common engines, so switching no longer requires knowing the individual
  `baseUrl` / `command` / `model` keys:
  - **STT:** `openai` (online, commercial cloud Whisper), `speaches` (offline, self-hosted
    faster-whisper, OpenAI-compatible), `whisper` (offline, local `whisper` / `whisper.cpp` CLI,
    no server).
  - **TTS:** `openai` (online, commercial), `openedai` (offline, self-hosted openedai-speech),
    `kokoro` (offline, self-hosted Kokoro-FastAPI), `piper` (offline, local Piper CLI),
    `edge-tts` (online, free edge-tts voices).
- **New `mercury voice` CLI command:**
  - `mercury voice presets` — list every STT and TTS preset with its offline/online and
    open-source/commercial tags.
  - `mercury voice use <stt|tts> <name>` — apply a preset; it writes the **entire** `voice.stt`
    or `voice.tts` block in one declarative reconfiguration, so no stale keys from the previous
    engine are left behind.
  - `mercury voice show` — print the current voice configuration.
- Each preset is validated against `ConfigSchema` in the test suite, so an applied preset is
  always a valid configuration.

### Changed
- Test suite expanded to **200 tests across 17 files** (added `tests/voicepresets.test.ts`).

## [0.5.0] - 2026-11-19

### Changed
- **Swappable STT/TTS providers (commercial ↔ open-source via one declarative config change).**
  The voice layer was refactored behind small `SttPort` / `TtsPort` abstractions
  (`packages/core/src/voice/ports.ts`) built by a config-driven factory (`voice/factory.ts`);
  `VoiceService` is now a thin facade with the same public API. The OpenAI path is now
  **OpenAI-compatible**: `voice.stt.baseUrl` / `voice.tts.baseUrl` (plus `apiKeyEnv`, `model`,
  `format`) let Mercury talk to any server implementing the `/audio/transcriptions` and
  `/audio/speech` routes — so switching from paid OpenAI to a self-hosted open-source server
  (e.g. faster-whisper-server / Speaches for STT, openedai-speech / Kokoro-FastAPI for TTS) is
  just `mercury config set voice.stt.baseUrl http://localhost:8000/v1`, no code change. The API
  key is required only for the real OpenAI host and optional for self-hosted endpoints.
- Fully-offline open-source paths remain first-class: STT via local `whisper` / `whisper.cpp`
  (`voice.stt.command`), TTS via `piper` or `edge-tts`.
- Config schema (`voice.stt` / `voice.tts`) extended additively with `baseUrl`, `apiKeyEnv`,
  `model`, `format`; existing configs keep working unchanged.
- Resolved the `mock` voice default inconsistency in the help docs. Mock STT/TTS providers are
  strictly test-only (gated on `MERCURY_ENABLE_MOCK=1`, never a production default).
- Test suite expanded to **195 tests across 16 files** (added `tests/voice.test.ts`).

## [0.4.0] - 2026-11-18

### Changed
- **Rate limiter is now SQLite-backed** instead of in-memory: a new `rate_limits` table (added via
  migration) holds per-client fixed-window counters in the same `mercury.db`, so limits persist
  across restarts and are shared across all requests in the process. Same window/limit semantics.
  Still single-host (cross-replica limiting would need an external store such as Redis/Postgres).
- **Lint rules hardened**: `@typescript-eslint/no-explicit-any` is now `error`, and
  `no-unused-expressions` disallows short-circuit and ternary statements
  (`{ allowShortCircuit: false, allowTernary: false }`). The only remaining `any` is a single
  commented `eslint-disable` on the existential `AnyTool` container type. `npx eslint .` exits 0.
- **esbuild postinstall warning silenced**: the root `package.json` pre-approves esbuild's build
  script (`"allowScripts": { "esbuild": true }`), so clean installs no longer warn on npm versions
  that gate build scripts.
- Expanded the unit-test suite from 174 to **185 tests across 15 files** (added
  `tests/ratelimit.test.ts` and `tests/help.test.ts`).

### Added
- **German help documentation**: full translations of all 16 help topics under `docs/help/de/`.
  The help system resolves `docs/help/<locale>/<topic>.md` from the effective `config.locale`
  (the same key that drives the German UI), falling back to the English topic when no translation
  exists.
- Documentation synced with the above (`STATUS.md`, `README.md`, `CONTRIBUTING.md`,
  `docs/GUIDE.md`, `docs/SECURITY.md`, `docs/COMPARISON.md`, `docs/ARCHITECTURE.md`,
  `docs/INSTALL_GUIDE.md`, `docs/QUICK.md`).

## [0.3.0] - 2026-11-18

### Added
- **Reliability & efficiency patterns** (`packages/core/src/reliability/`): a `CircuitBreaker`
  (closed/open/half-open with `CircuitOpenError`), a `Saga` orchestrator with compensating
  rollback, a `TtlCache` with expiry/clear, and `SingleFlight` request coalescing. Exponential
  backoff with bounded jitter is reused from the LLM layer. Documented in `docs/RELIABILITY.md`.
- **LLM Wiki subsystem** (ingest / query / lint): a retrieval-and-synthesis knowledge store
  exposed as `wiki_*` built-in tools and a `mercury wiki` CLI command, with re-ingest
  accumulation, deduplication and concurrent-query coalescing. Documented in `docs/WIKI.md`.
- **Declarative Add-In system** (`packages/core/src/addins/`): manifest-driven add-ins loaded
  from `~/.mercury/addins/`, with a path-traversal guard, malformed/missing-manifest skipping,
  and a `mercury addin` CLI. Documented in `docs/ADDINS.md`.
- **Per-agent / per-personality permission profiles**: an `effectivePolicy` strict-intersection
  merge enforced across model use, workflow runs, tool globs and token scope, with a
  `mercury perms` CLI. Documented in `docs/PERMISSIONS.md`.

### Changed
- Expanded the unit-test suite from 147 to 174 tests covering the reliability, wiki, add-in and
  permission subsystems.
- Documentation synced with the new features (`README.md`, `STATUS.md`, `docs/COMPARISON.md`,
  `docs/GUIDE.md`, `docs/ARCHITECTURE.md`, `docs/EXTENDING.md`, `docs/SECURITY.md`); regenerated
  `README.pdf` and `docs/GUIDE.pdf`.

## [0.2.0] - 2026-11-15

### Added
- Authentication/authorization audit coverage: successful and failed logins
  (`auth.login` / `auth.login_failed`, with a failure reason of `unknown_user`, `bad_password`
  or `account_disabled`), API token issuance and revocation (`token.issue` / `token.revoke`),
  and gateway pairing approvals and rejections (`pairing.approve` / `pairing.reject`). Events are
  recorded at the service layer, so both the HTTP API and the CLI are covered. Attempted passwords
  are never stored.
- Filtered, paginated audit queries: `AuditLog.query({ actor, action, target, since, until, limit,
  offset })` where `action` matches an exact value or a dotted prefix (e.g. `token` matches
  `token.issue` and `token.revoke`). Exposed over `GET /api/audit?...` (admin-only) with a `total`
  count, and via the new `mercury audit [list|verify]` CLI command.
- Self-evaluation harness and `mercury eval [--tag <t>] [--json]` command with a built-in
  deterministic benchmark (round-trip answers, explicit and natural-language tool dispatch,
  tool-result grounding, memory writes), reporting pass/score plus per-run token and cost accounting.
- Resilient provider calls: retryable errors retry with exponential backoff and bounded jitter
  (configurable `llm.retryBackoffMs` / `llm.retryJitter`); each retry emits a structured
  `llm.retry` event. Non-retryable errors fail fast; the cross-model fallback chain is unchanged.
- Token and estimated-cost accounting recorded to the usage ledger and emitted as events.
- `docs/COMPARISON.md` — honestly-scoped feature comparison with Hermes Agent.
- Standard repository files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, root
  `SECURITY.md`, `.gitattributes`, `.editorconfig`, `.nvmrc`.
- Mercury Agent icon used across the web UI (favicon, login card, sidebar) and documentation.

### Changed
- User registration, updates and deletion (`user.register` / `user.update` / `user.delete`) are now
  audited at the service layer instead of only in the HTTP route handlers, so admin actions taken
  through the CLI (`mercury user add|role|delete`) and the `POST /api/users` admin route — previously
  unaudited — are now captured, each attributed to the operating principal. `user.update` records only
  the fields that actually changed.
- Test suite expanded from 49 to 90 tests across 9 files (all offline against the mock provider),
  including a dedicated `tests/audit.test.ts` for the authentication/authorization audit coverage.
- Documentation refreshed: README documentation index, PDFs regenerated with the embedded logo.

## [0.1.0] - 2026-11-13

### Added
- Initial public release of the Mercury monorepo: seven packages (`core`, `tools`, `mcp`,
  `gateway`, `runtime`, `server`, `cli`).
- Streaming agent loop with multiple reasoning patterns, subagents and run controls.
- LLM providers (OpenRouter, Ollama, LM Studio, OpenAI-compatible, Anthropic) with a model router
  and per-user/model budgets; optional **Jev** decision engine.
- Memory (working, episodic, semantic, procedural, user model, blackboard), reflection and skills.
- 76 built-in tools in toolsets, polyglot tools, and MCP client **and** server.
- YAML multi-agent workflows, a natural-language/cron scheduler, and 16 chat-platform gateways.
- Voice (STT/TTS), security controls (scrypt + JWT, RBAC, guardrails, path jail, SSRF guard,
  audit log), observability (event traces, replay, Prometheus `/metrics`) and a no-build web UI.
- MIT license.

[Unreleased]: https://github.com/ms1963/mercury_agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ms1963/mercury_agent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ms1963/mercury_agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ms1963/mercury_agent/releases/tag/v0.1.0
