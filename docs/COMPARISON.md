![Mercury Agent](../assets/mercury_agent.png)

# Mercury vs Hermes Agent

**How this document is scoped (please read first).**

Mercury's original goal, stated in its own README, was *"feature parity with Hermes Agent plus the
Jev decision engine."* This document records where Mercury now goes **beyond** that parity baseline
with real, implemented, and — where marked — **deterministically tested** capabilities.

Honesty rules this table obeys:

- The **Mercury** column describes only code that exists in **this repository**. The **Tested** column
  means covered by the offline `vitest` suite (`MERCURY_ENABLE_MOCK=1 npm test`) and/or run by hand in
  this environment. It never means tested against a real external LLM, a real Jev API, a real chat
  platform, or a real STT/TTS service — see [STATUS.md](../STATUS.md) for the precise
  tested-vs-untested breakdown.
- The **Hermes Agent** column reflects Mercury's *parity target* and Hermes's publicly-known
  positioning. **It is not a benchmark of a Hermes installation** — no Hermes instance was run or
  measured for this document. Treat it as "the baseline Mercury set out to match," not as a verified
  competitor measurement. Where Mercury's behaviour relative to Hermes cannot be verified from this
  repo, the cell says so rather than claiming an advantage.
- There are **no invented benchmarks, scores, or latency/throughput numbers** anywhere in this file.

## 1. Parity baseline (feature-for-feature)

These are the capabilities Mercury implements to match the Hermes Agent baseline. All are implemented
in this repo; the **Tested (offline)** column reflects Mercury's own suite.

| Capability | Mercury | Hermes Agent (parity target) | Tested (offline, Mercury) |
|---|---|---|---|
| CLI + web UI | ✓ | ✓ | ✓ (CLI commands; web UI manual) |
| Chat-platform gateways | ✓ 16 adapters | ✓ | Partial — Telegram/Slack/webhook via mock transports only |
| Multi-agent workflows | ✓ YAML templates (pipeline, debate, map-reduce, coordinator-worker, tree, router, blackboard…) | ✓ | ✓ (pipeline + debate run offline) |
| Persistent memory | ✓ working, episodic, semantic, procedural (skills), user model, blackboard | ✓ | ✓ (facts, curated MEMORY.md/USER.md) |
| Skills (`SKILL.md`) | ✓ agentskills.io format | ✓ | ✓ (list/create; install from path/git untested) |
| Tool library | ✓ 79 built-ins + polyglot (any language) | ✓ | ✓ (catalogue, safe tools, Python+JS polyglot) |
| MCP client **and** server | ✓ both | Typically client-side | ✓ (in-memory client↔server roundtrip; `/mcp` scope) |
| Reasoning patterns | ✓ react, cot, plan-execute, reflexion, tot, self-consistency, critic | ✓ | ✓ (via agent-loop tests) |
| Security: auth, RBAC, guardrails | ✓ scrypt+JWT, scoped tokens, RBAC, injection guardrails, path jail, SSRF guard, secret redaction, audit log | ✓ | ✓ (dedicated security suite) |

## 2. What makes Mercury superior (beyond the parity baseline)

Each item below is implemented in this repo. "Tested (offline)" items have dedicated deterministic
tests in the `vitest` suite that run with the mock provider and no network.

| Differentiator | What it adds | Where | Tested (offline) |
|---|---|---|---|
| **Jev decision engine** | A typed decision layer that drives model **routing** (by task class / cost / capability / context size), **risk judgment** feeding tool-approval "smart" mode, gateway **triage**, and **reflection** triggers. Falls back to a safe heuristic when unconfigured. | `packages/core/src/decision/*`, `router/router.ts` | ✓ Jev decision provider (mocked HTTP), router tag inference + scoring |
| **Self-evaluation harness** (`mercury eval`) | A built-in, deterministic benchmark Mercury runs **against itself** to catch regressions: round-trip answers, explicit + natural-language tool dispatch, tool-result grounding, and memory writes. Pure, unit-testable scoring; `--tag` filtering and `--json` output. | `packages/core/src/eval/suite.ts`, `packages/cli` (`eval` command) | ✓ scoring (pure), suite selection, **end-to-end run (5/5 tasks pass)** |
| **Resilient provider calls** | Retries on **retryable** provider errors use **exponential backoff with bounded jitter** (configurable `llm.retryBackoffMs`, `llm.retryJitter`) to avoid thundering-herd retries; non-retryable errors **fail fast** (no wasted attempts); a cross-model/provider **fallback chain** is attempted when a model fails. Every retry emits a structured `llm.retry` event. | `packages/core/src/llm/backoff.ts`, `llm/service.ts` | ✓ backoff math (injectable RNG), **retryable error recovers via retry**, **non-retryable fails fast** |
| **Token + cost accounting** | Per-call input/output token counts and an **estimated cost** (from per-1M-token model rates) are recorded to the usage ledger, emitted as `llm.response` events, and **surfaced per-run** by the eval command. | `packages/core/src/budgets/budgets.ts` (`costOf`), `llm/service.ts`, `eval` command | ✓ `costOf` math, per-run accounting in the eval run |
| **Observability & replay** | Every run emits a full event trace; `mercury replay <runId>` prints it; a live debug stream supports breakpoints and pause/resume; Prometheus `/metrics` endpoint. | `packages/core/src/events/*`, `packages/server` | ✓ run events, recorder replay, `/metrics` |
| **Per-user/model budgets** | Daily/monthly token and cost budgets with admin bypass, enforced before each call. | `packages/core/src/budgets/budgets.ts` | ✓ token budget blocks a user |
| **LLM Wiki** (`mercury wiki …`) | Karpathy-style ingestion-time synthesis instead of query-time RAG: sources are stored immutably in `raw/`, the LLM authors cross-linked markdown pages in `wiki/`, and a maintained `index.md`/`log.md` track them. `ingest` / `query` (grounded, cites raw sources) / `lint` (orphans, broken links, stubs, staleness, LLM contradiction check, plus a `--delta` fast path). Also exposed as `wiki_ingest` / `wiki_query` / `wiki_lint` agent tools. | `packages/core/src/wiki/service.ts`, `packages/tools/src/builtin/wiki.ts` | ✓ init/ingest/query/lint + delta against a **test-local fake LLM** (offline); **real-model synthesis/answer/contradiction quality is untested** |
| **Reliability & efficiency patterns** | A dependency-free toolkit the runtime wires into provider calls: a 3-state **CircuitBreaker** (per-model, trips on `ProviderError.retryable`), a **Saga** compensation orchestrator, a **TtlCache** (LRU + TTL), **SingleFlight** request coalescing, and a shared **retry** wrapper reusing the one `backoffDelay` (exponential backoff + jitter). Declarative `llm.circuitBreaker.*` config. | `packages/core/src/reliability/*` | ✓ 36 deterministic tests (injectable clock/RNG): CB state machine incl. half-open, Saga rollback, cache expiry/eviction, single-flight coalescing + error propagation, retry |
| **Declarative Add-In system** (`mercury addin …`) | Users drop a self-contained package into `~/.mercury/addins/<name>/` (a manifest plus personalities, polyglot tool folders, and permission profiles) to extend Mercury **without editing any source**. Malformed add-ins are skipped with a warning, never crashing the runtime; a path-traversal guard confines every declared path to the add-in dir. `scaffold` writes a ready-to-load template. | `packages/core/src/addins/*` | ✓ loader (valid/disabled/malformed/path-escape/duplicate), profile loader, scaffold |
| **Per-agent/personality permission profiles** (`mercury perms …`) | A personality/agent can be bound to a permission profile that **further restricts** the acting user and can never escalate: `effectivePolicy` unions deny-lists, takes the minimum `maxToolRisk`, and intersects allow-lists (glob-aware). Enforced by `PolicyEngine` across `tool.use`, `model.use` and `workflow.run`. | `packages/core/src/auth/policy.ts`, `addins/permissions.ts` | ✓ merge semantics + end-to-end enforcement (tool/model/workflow, scope checks, admin bypass) |

### The `mercury eval` command

```
$ MERCURY_ENABLE_MOCK=1 mercury eval
Mercury self-evaluation
PASS  basic-roundtrip            score=1.00  tok=420/9   $0.000000  27ms
PASS  tool-explicit-calculator   score=1.00  tok=843/20  $0.000000  35ms
PASS  tool-nl-calculator         score=1.00  tok=833/20  $0.000000  31ms
PASS  memory-write               score=1.00  tok=870/30  $0.000000  37ms
PASS  tool-result-grounding      score=1.00  tok=845/20  $0.000000  29ms

5/5 passed  mean-score=1.00  tokens=3811/99  est-cost=$0.000000  159ms
```

The estimated cost is `$0.000000` above because the run used the **offline mock provider**, whose
model profile has zero per-token rates — this is honest, not a placeholder. Against a configured real
provider the same accounting reports real token counts and the estimated cost from that model's rates.
`--tag <tag>` runs a subset (e.g. `tools`, `memory`); `--json` emits the full machine-readable report.

## 3. Honest limitations (unchanged by this comparison)

- Nothing here has been run against a **real** LLM provider, Jev API, chat platform, or STT/TTS
  service. The eval harness and resilience features are proven **only** against the deterministic mock.
- The Hermes Agent column is a parity/positioning reference, **not** a measured benchmark.
- Mock agent quality is intentionally simple (echo + explicit/NL tool triggers); real agent quality
  depends on the configured model.
- See [STATUS.md](../STATUS.md) for the full tested-vs-untested matrix and
  [docs/GUIDE.md](GUIDE.md) for the complete reference.

---

*All claims above are grounded in code in this repository and the offline test suite. Build:
`npm run build` (exit 0). Tests: `MERCURY_ENABLE_MOCK=1 npm test` (185/185 across 15 files, offline).*
