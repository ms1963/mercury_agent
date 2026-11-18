# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
