# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Test suite expanded from 49 to 69 tests across 8 files (all offline against the mock provider).
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

[Unreleased]: https://github.com/ms1963/mercury_agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ms1963/mercury_agent/releases/tag/v0.1.0
