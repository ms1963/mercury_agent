# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ms1963/mercury_agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ms1963/mercury_agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ms1963/mercury_agent/releases/tag/v0.1.0
