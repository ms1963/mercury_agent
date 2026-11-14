Mercury Agent **v0.1.0** — the first public release.

Mercury Agent is a self-hosted, extensible agentic AI platform written entirely in TypeScript and designed to run on Node.js 22.5+. It is a runtime *around* a large language model rather than a model in a box: the same agent machinery works unchanged against a local model (Ollama, LM Studio) or a remote OpenAI-compatible service (Abacus.AI ChatLLM, OpenRouter, OpenAI, Anthropic).

### Highlights

- **Monorepo, seven packages** — `core`, `tools`, `mcp`, `gateway`, `runtime`, `server`, `cli` — with a strict inward dependency direction that keeps the domain logic framework-free and testable.
- **Streaming agent loop** with multiple reasoning patterns (reason-and-act, plan-and-execute, reflexion), subagents and interactive run controls (stop, retry, undo, checkpoint, context compression).
- **Local and remote LLMs, one interface** — providers for OpenRouter, Ollama, LM Studio, OpenAI-compatible endpoints and Anthropic, with a model router and per-user / per-model budgets; optional **Jev** decision engine that separates "decide" from "answer" (falls back to a safe heuristic when unconfigured).
- **Memory and skills** — working, episodic, semantic, procedural, user-model and blackboard memory, plus reflection and a skills system.
- **76 built-in tools** across toolsets, polyglot tools in any language, and Model Context Protocol support as **both client and server**.
- **Orchestration and integrations** — YAML multi-agent workflows, a natural-language / cron scheduler, and 16 chat-platform gateways (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Teams, IRC, email, SMS, Home Assistant, RSS, webhook, web widget, CLI).
- **Voice** (STT / TTS), **security** (scrypt + JWT, RBAC, guardrails, path jail, SSRF guard, untrusted-content tagging, hash-chained audit log) and **observability** (event traces, replay, Prometheus `/metrics`) with a no-build single-page web UI.
- **Self-evaluation harness** — `mercury eval [--tag <t>] [--json]` runs a deterministic benchmark (round-trip answers, explicit and natural-language tool dispatch, tool-result grounding, memory writes) reporting pass/score plus per-run token and cost accounting.
- **Resilient provider calls** — retryable errors retry with exponential backoff and bounded jitter (`llm.retryBackoffMs` / `llm.retryJitter`), each retry emitting a structured `llm.retry` event; non-retryable errors fail fast.
- MIT licensed.

### Getting started

```bash
git clone https://github.com/ms1963/mercury_agent mercury && cd mercury
npm install
npm run build
node packages/cli/dist/bin.js setup     # create admin user, choose a provider
node packages/cli/dist/bin.js serve     # web UI + API on http://localhost:3000
```

A standalone, mock-free dual-mode (local + remote) LLM client example lives at `examples/llm-local-remote/llm-client.ts`, and an in-depth field guide is in `docs/ARTICLE.txt`.

### Maturity — read before production use

This is an early release (0.1.0). The implemented surface area is large, but it has **not** yet been hardened at scale against the full range of real external chat platforms and voice services. The test suite (69 tests across 8 files) runs fully offline against a mock provider that exists **only** for testing and is disabled in normal operation, where a real model is required. See `STATUS.md` in the repository for the authoritative, subsystem-by-subsystem record of what has and has not been exercised against live services.

### Assets

`mercury-full.zip` contains the complete source tree (excluding `node_modules`); you can also clone the tag directly.
