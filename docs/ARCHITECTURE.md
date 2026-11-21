# Mercury — Architecture

Mercury is a self-hosted, extensible agentic AI platform written in TypeScript (Node 22+, ESM,
npm-workspaces monorepo). It aims for feature parity with Hermes Agent (Nous Research) and adds
multi-agent workflows, a typed decision engine (Jev), RBAC, token budgets and an MCP server.

This document explains *how the system is put together*. For security details see
[SECURITY.md](SECURITY.md); for writing extensions see [EXTENDING.md](EXTENDING.md).

---

## 1. Design principles

1. **Small, explicit interfaces.** Every subsystem is behind a TypeScript interface
   (`LLMProvider`, `Tool`, `Pattern`, `WorkflowTemplate`, `DecisionProvider`, `Adapter`,
   `MemoryProvider`, `Plugin`, `SttProvider`, `TtsProvider`, `TerminalBackend`, `BrowserBackend`).
2. **Offline first.** A deterministic `mock` LLM, `mock` decision provider, hash embeddings and
   mock STT/TTS let everything run and be tested without API keys or network.
3. **One composition root.** `@mercury/runtime` (`createMercury()`) wires all services. The CLI,
   the HTTP server, the gateway, the scheduler and the MCP server are thin front-ends over it.
4. **Everything is an event.** Every LLM call, tool call, memory op, decision and thought is
   published on the `EventBus`, persisted as a trace and streamable to the UI.
5. **Untrusted by default.** Content that did not come from the authenticated user (tool output,
   web pages, e-mails, attachments, MCP results) is tagged and spotlighted, and can never trigger
   sensitive tools without approval.

---

## 2. Layered architecture

```mermaid
flowchart TB
  subgraph Frontends
    CLI[CLI / REPL] ---|uses| RT
    WEB[Web UI SPA] -->|HTTP+SSE| SRV[HTTP Server - Fastify]
    MCPS[MCP Server stdio/HTTP] --> RT
    GW[Messaging Gateway] --> RT
    SCH[Scheduler] --> RT
  end
  SRV --> RT[Runtime: createMercury]
  subgraph Orchestration
    RT --> AG[Agent + Patterns]
    RT --> WF[Workflow Engine]
    WF --> AG
    AG --> RTR[Model Router]
    AG --> TX[Tool Executor]
    AG --> REF[Reflection]
  end
  subgraph Judgment
    DEC[Decision Engine: Jev / LLM / Mock]
  end
  RTR --> DEC
  TX --> DEC
  REF --> DEC
  subgraph Capabilities
    TX --> TOOLS[Built-in tools, polyglot tools, MCP client tools]
    AG --> MEM[Memory: working, episodic, semantic, procedural, user model, blackboard]
    AG --> SK[Skills]
    RTR --> LLM[LLM providers]
    SK --> COMP[Skill composer]
  end
  subgraph Learning
    LRN[Learning service: experience hints, auto-tuned routing, failure playbooks]
  end
  AG --> LRN
  RTR --> LRN
  LRN --> DB
  subgraph Foundation
    CFG[Config zod] --- BUS[EventBus + Tracer + Metrics]
    DB[(SQLite + FTS5)] --- SEC[Security: guardrails, audit, redaction, SSRF, jail]
    AUTH[Auth + RBAC/ABAC + Budgets]
  end
  Capabilities --> Foundation
  Orchestration --> Foundation
```

| Layer | Responsibility | Packages / folders |
|---|---|---|
| Frontends | Human & machine entry points | `packages/cli`, `packages/server` (+`public/` SPA), `packages/mcp` (server), `packages/gateway`, scheduler in core |
| Composition | Builds and owns all services | `packages/runtime` |
| Orchestration | Agent loop, reasoning patterns, workflows, subagents, reflection | `core/src/agent`, `core/src/workflows`, `core/src/reflection` |
| Judgment | Typed calibrated decisions (Jev) for routing and meta-cognition | `core/src/decision` |
| Capabilities | LLMs, router, tools, memory, skills (incl. composition), voice, attachments | `core/src/llm`, `core/src/router`, `packages/tools`, `core/src/memory`, `core/src/skills`, `core/src/voice`, `core/src/attachments` |
| Learning | Experience hints, auto-tuned routing, failure playbooks (from run history) | `core/src/learning` |
| Foundation | Config, DB, events, logging, security, auth, budgets, i18n, help | `core/src/{config,db,events,logging,security,auth,budgets,i18n,help}` |

---

## 3. Package map

```
mercury/
├─ packages/
│  ├─ core/        @mercury/core     — domain logic, interfaces, no HTTP server
│  │  └─ src/
│  │     types/  config/  db/  events/  logging/  security/  auth/  budgets/
│  │     llm/  router/  decision/  agent/  agent/patterns/  memory/  skills/ (+composer)
│  │     learning/  reflection/  tools/ (registry+executor)  workflows/  scheduler/
│  │     attachments/  voice/  plugins/  checkpoints/  i18n/  help/  extensions/
│  ├─ tools/       @mercury/tools    — 50+ built-in tools, toolsets, polyglot runner,
│  │                                    execute_code sandbox, terminal & browser backends
│  ├─ mcp/         @mercury/mcp      — MCP client manager + Mercury-as-MCP-server + curated presets
│  ├─ gateway/     @mercury/gateway  — adapter SDK, gateway runner, 19 adapters
│  ├─ runtime/     @mercury/runtime  — createMercury(): composition root
│  ├─ server/      @mercury/server   — Fastify REST/SSE API, webhooks, /mcp, web UI
│  └─ cli/         @mercury/cli      — `mercury` binary, REPL, subcommands, scaffolding
├─ skills/            bundled skills (SKILL.md, agentskills.io format)
├─ tools/             polyglot example tools (Python, JS, C++, Java, Go) with tool.json
├─ workflows/         bundled workflow specs (YAML)
├─ personalities/     bundled personalities (*.md)
├─ locales/           i18n catalogs (en.json, de.json)
├─ docs/              architecture, security, extending, help topics (docs/help/*.md + docs/help/de/*.md)
└─ deploy/            Dockerfile, docker-compose.yml, systemd unit
```

Dependency direction: `cli, server → runtime → {tools, mcp, gateway} → core`. `core` depends
only on `zod` and `yaml` (and Node built-ins, including `node:sqlite`).

---

## 4. Main data flow (one chat turn)

```mermaid
sequenceDiagram
  participant U as User (CLI/UI/chat app)
  participant F as Frontend
  participant A as Agent
  participant G as Guardrails
  participant R as Router(+Jev)
  participant B as Budgets
  participant L as LLM
  participant T as ToolExecutor
  participant M as Memory/Skills
  participant X as Reflection(+Jev)
  U->>F: message (+attachments, @refs, /commands)
  F->>A: run({sessionId, userId, input})
  A->>G: input guardrail (injection heuristics + classifier, PII)
  A->>M: build context (SOUL/AGENTS files, curated memory, skills index, recall, learned hint)
  A->>R: pick model (rules, capabilities, cost/latency/quality, Jev choice, learned routing)
  loop pattern (ReAct by default)
    A->>B: pre-call budget check
    A->>L: chat(messages, tools) [stream deltas -> events]
    A->>B: record usage
    A->>T: tool calls (policy, approval, hooks, sandbox, timeout)
    T-->>A: results tagged <untrusted> when external
  end
  A->>G: output guardrail (secret/PII redaction)
  A-->>F: streamed answer + events
  A->>X: post-task reflection (score, lessons, skill create/refine, calibration)
```

Every arrow above emits an event (`run.start`, `llm.request`, `llm.delta`, `llm.response`,
`tool.call`, `tool.result`, `decision`, `memory.*`, `guardrail.*`, `run.end`) carrying `runId`,
`spanId` and `parentSpanId`. Events are persisted (`events` table) for replay and debugging.

---

## 5. Key subsystems

### 5.1 Agent core (`core/src/agent`)
* `Agent.run()` prepares context, selects a model and a `Pattern`, runs it, applies output
  guardrails, persists messages and triggers reflection.
* `ReactLoop` is the primitive: LLM call → native tool calls (or text-ReAct fallback parsing
  `Action:`/`Action Input:` for models without tool calling) → execute → repeat, with retries,
  abort signal (`/stop`), max-iteration limit, streaming deltas and debug breakpoints.
* Patterns (`core/src/agent/patterns`): `react`, `cot`, `plan-execute`, `reflexion`, `tot`,
  `self-consistency`, `critic`; selectable explicitly, by config, or automatically by Jev.
* Slash commands (`/new /reset /model /retry /undo /stop /compress /usage /insights /skills
  /rollback /personality /pattern /help /<skill>`) are implemented once in
  `agent/commands.ts` and reused by CLI, web UI and gateway.

### 5.2 Decision engine — Jev (`core/src/decision`)
* `DecisionEngine` exposes `choice`, `noul`, `score` and batch `decide()` with typed answers
  (`{choice, confidence, probabilities}`, `{noul}`, `{score, probabilities, confidence}`).
* Providers: `JevDecisionProvider` (OpenRouter Decisions API `POST /api/alpha/decisions`,
  model `typesafe/jev-1.13`), `LlmDecisionProvider` (structured JSON + self-reported
  confidence), `MockDecisionProvider` (deterministic keyword heuristics). Chain with fallback.
* **(a) Routing/judgment**: model selection, pattern/workflow selection, tool-approval gating,
  prompt-injection classification, message/mail triage with a human-review queue.
* **(b) Meta-cognition**: step and answer scoring (Score), retry/escalate (Noul), next
  strategy (Choice), and calibration (predicted vs. observed outcome, Brier score).

### 5.3 LLM layer and router (`core/src/llm`, `core/src/router`, `core/src/budgets`)
* Unified `ChatMessage` with attachments (image/audio/video/document); providers degrade
  gracefully (audio → transcript, video → frames/transcript, image → description) when the
  model lacks a capability.
* Providers: `openai`, `anthropic`, `openrouter`, `ollama`, `lmstudio`, `openai-compatible`
  (any number of named endpoints), `mock`.
* `ModelRouter`: explicit model > rules (regex/tags) > capability filter > weighted score
  (quality, cost, latency) > optional Jev choice among top-k > fallback chain on errors.
* `BudgetService`: per user × model × period (daily/monthly) limits on tokens and cost,
  checked before (estimate) and after (actual) each call, admin override, usage ledger.
* **Economics & routing** (`router.economics`, `core/src/budgets/task-budgets.ts`): each model
  profile carries a `lane` (`local` | `frontier` | `default`); `inferDifficulty` scores a task
  from cheap offline signals and `selectCheapestSufficient` picks the cheapest model whose quality
  tier clears that bar (routine tasks stay on the near-zero-cost local lane, harder tasks exclude
  local). `TaskBudgetService` enforces a cost/token ceiling scoped to one task/run, checked by the
  `LLMService` before every call — exceeding it throws `TaskBudgetExceededError` and the task is
  halted or escalated (`budgets.perTask.onExceed`). A running **cost-vs-value** estimate is exposed
  via `GET /api/tasks`. The `RouteDecision` now also reports `lane` and `qualityNeed`.
* **Learned routing hook** (`RouteLearner`): the router exposes an optional `setLearner()` seam.
  After its economics/decision choice it asks the learner to `suggest(bucket, candidates)` the model
  with the best *observed* success rate for the task's difficulty bucket; when the learner has enough
  data it overrides the choice and the `RouteDecision` is flagged `adjustedByLearning`, otherwise the
  router keeps its own pick (graceful, backward-compatible). The implementation is the
  `LearningService` (§5.17); `routeBucket`/`inferDifficulty` are shared between the two.

### 5.4 Memory (`core/src/memory`)
| Kind | Implementation |
|---|---|
| Working | message window + `ContextCompressor` (`/compress`, automatic at threshold) |
| Episodic | `sessions`/`messages` tables + FTS5 `messages_fts`; `search_sessions` with LLM summary |
| Semantic | `facts` table + FTS5 + hand-written cosine vector index; pluggable embeddings |
| Curated | bounded `MEMORY.md` + `USER.md` per user (Hermes-compatible, char limits) |
| Procedural | skills (see 5.5) + skill statistics |
| User model | dialectic profile (observations → traits with confidence), Honcho-like |
| Blackboard | shared key/value + posts per workflow run (persisted) |
| External | `MemoryProvider` interface, registered by plugins |

All memory is scoped by `userId` (and optional `scope` such as a project or workflow run).

### 5.5 Skills (`core/src/skills`)
`SKILL.md` with agentskills.io frontmatter (`name`, `description`, optional `license`,
`compatibility`, `allowed-tools`, `metadata`). Progressive disclosure: the system prompt carries
only the index (name + description); `skill_view` loads full content; supporting files on
demand. Skills are discovered from bundled, `~/.mercury/skills` and `./.mercury/skills`,
installable from a folder or git URL, created autonomously by reflection and refined by
`skill_update` with success statistics.

**Skill composition** (`core/src/skills/composer.ts`, config `composition`): a `SkillComposer` runs a
small pipeline whose steps are either tool calls (`{tool, args}`) or nested sub-skill compositions
(`{skill, steps, inputs}`). Every tool step goes back through the **real** `ToolExecutor`, so policy,
approval, audit, taint and chaos all still apply. Intermediate results are memoised in a bounded
`TtlCache` (keyed on skill + inputs + steps) and runaway is guarded two ways — a hard depth limit
(`composition.maxDepth`) with active-stack cycle detection, and a per-composition step budget
(`composition.maxSteps`). Exposed as the `skill_compose` tool (§5.6). Additive: nothing runs it unless
the tool (or an explicit caller) is used.

### 5.6 Tools (`core/src/tools`, `packages/tools`, `packages/mcp`)
* `Tool` = name, toolset, description, zod/JSON schema, `risk` (`safe|moderate|dangerous`),
  `untrustedOutput` flag, `execute(args, ctx)`.
* `ToolExecutor` pipeline: policy (RBAC/ABAC) → **policy-as-code** (`PolicyCodeEngine`:
  `allow`/`deny`/`approve`, strictest wins) → **grant check** (`GrantBroker`: least-privilege,
  time-limited, no standing keys) → trust check (untrusted-derived calls) → Jev/LLM gate →
  approval → `before_tool_call` hooks → checkpoint → execute with timeout → redaction →
  spotlighting → **taint tracking** of untrusted output (`TaintTracker`) → `after_tool_call`
  hooks → audit (replayable via `buildTrace`). See 5.13 and [SECURITY.md](SECURITY.md).
* Toolsets can be enabled/disabled globally and per platform (`cli`, `web`, `telegram`, …).
* Polyglot tools: any executable with a `tool.json` manifest speaking JSON over stdio.
* MCP client tools are namespaced `mcp__<server>__<tool>` and filtered per server.
* **Gated web reader** (`web_read`, toolset `web`): fetches a page through the SSRF-guarded
  `safeFetch` and returns the *readable main content* (title + article text, boilerplate stripped by
  `extractMainContent`), optionally with the page's links. Unlike `web_fetch` (risk `safe`), it is
  risk-tagged `moderate`, marked `sensitive` and **always requests approval**, so opening an arbitrary
  URL goes through the same approval/policy/audit path as other sensitive actions; its output is
  tainted. A headless-browser backend was deliberately deferred — the current implementation is HTTP
  fetch + HTML extraction.
* **Skill composition tool** (`skill_compose`, toolset `skills`, risk `moderate`): drives the
  `SkillComposer` (§5.5) behind `ctx.services.composition`; returns an error (not a throw) when
  composition is disabled.

### 5.7 Multi-agent workflows (`core/src/workflows`)
Templates: `single`, `pipeline`, `blackboard`, `coordinator-worker`, `tree`, `debate`,
`map-reduce`, `router`, `round-robin`, `planner-executor`. A workflow spec (YAML/JSON) names a template,
agents (role, model, toolsets, pattern) and budgets. `WorkflowContext.spawn()` enforces
`maxSubagentsPerAgent` (concurrency, default 3), `maxDepth`, and per-run budgets (agents,
steps, tokens, wall-clock). `delegate_task` uses the same mechanism.

**Planner-executor** (`workflows/templates/planner.ts`, config `workflows.planner`): the fix for
workflows terminating too early. A planner makes one structured LLM call to decompose the goal into an
ordered list of between `minSteps` and `maxSteps` steps (aiming for `targetSteps`); an executor agent
runs each step in turn, fed the accumulated results of prior steps, emitting one `workflow.step` per
step; on a failed step, if `replanOnFailure` is set, it re-plans the remaining work once
(`workflow.replan`) and continues, bounded by the hard `maxSteps` cap and the workflow budget; a
`synthesizer` agent (or a final `complete` call) merges the step outputs into one answer. Planning
degrades gracefully — when the LLM returns no usable JSON the plan is padded with deterministic generic
steps so the workflow still runs the configured depth. The planner is **off by default**; step budgets
come from config and can be overridden per workflow via `spec.options`.

### 5.8 Gateway (`packages/gateway`)
One process hosts many `Adapter`s. Inbound messages are normalized to `InboundMessage`
(text, attachments, sender, chat), voice memos are transcribed, unknown senders receive a DM
pairing code, identities are linked to Mercury users, conversation continuity is per user across
platforms (configurable), optional Jev triage routes low-confidence items to a review queue.

### 5.9 Scheduler (`core/src/scheduler`)
Persistent schedules (cron, natural language, intervals, one-shot) running agents or workflows
with attached skills, delivering to gateway targets; pause/resume/edit/run-now, history,
retries, budgets.

### 5.10 Reliability & efficiency primitives (`core/src/reliability`)
A small set of composable, dependency-free primitives: a `CircuitBreaker` (closed → open →
half-open), a `Saga`/`runSaga` compensation orchestrator (forward steps with LIFO rollback on
failure), a `TtlCache` (lazy-expiring, size-bounded), `SingleFlight` (coalesces concurrent calls
for the same key into one in-flight promise), and `retry`/`backoffDelay` (exponential backoff with
bounded jitter; the backoff logic is shared with `core/src/llm/backoff.ts`). The LLM layer wires the
circuit breaker and retry/backoff into provider calls (`llm.circuitBreaker.*`, `llm.retry*`). See
[RELIABILITY.md](RELIABILITY.md).

### 5.11 LLM Wiki (`core/src/wiki`)
An ingestion-time knowledge base (Karpathy's "LLM wiki" pattern): raw sources are stored immutably
under `raw/`, the LLM synthesises/updates cross-linked markdown pages under `wiki/`, and `index.md` /
`log.md` track the corpus. Operations: **ingest** (store raw + synthesise), **query** (consult index,
read relevant pages, answer with citations) and **lint** (orphans, broken links, stubs, staleness,
LLM-assisted contradictions, plus a delta-lint of recently touched pages). Exposed as the `wiki_*`
tools and `mercury wiki …`. The synthesis/query/contradiction quality is **untested against a real
LLM** — only against a test-local fake. See [WIKI.md](WIKI.md).

### 5.12 Add-Ins & permission profiles (`core/src/addins`, `core/src/auth/policy.ts`)
A unified declarative Add-In loader discovers tools, personalities and permission profiles dropped
into `<dataDir>/addins/` (and `<dataDir>/permissions/`) without source edits — additive and
backward-compatible with the legacy `personalities/`, `tools/` and `plugins/` scans; malformed
manifests and path-escaping entries are skipped with warnings. `effectivePolicy()` merges a base
policy with a per-agent/personality profile by **strict intersection** (deny = union, max tool-risk =
min, allow-lists intersected) so a profile can only further-restrict, never escalate. CLI:
`mercury addin list|scaffold`, `mercury perms list|show`. See [ADDINS.md](ADDINS.md) and
[PERMISSIONS.md](PERMISSIONS.md).

### 5.13 Governance & security (`core/src/auth/grants.ts`, `core/src/security/{policy-code,taint}.ts`, `core/src/events/replay.ts`)
Four governance layers in front of sensitive actions, all config-driven and backward-compatible:
* **`GrantBroker`** — least-privilege, time-limited credential grants bound to a task (no standing
  keys). Ephemeral credentials are minted in memory against a grant and never persisted; capability
  checks deny with `GrantDeniedError` when no live grant exists. Config `security.grants`.
* **`PolicyCodeEngine`** — declarative policy-as-code (`allow`/`deny`/`approve`, strictest wins) with
  a built-in payment-cap + external-email rule set, evaluated before sensitive tool actions. Config
  `security.policies`.
* **`TaintTracker`** — marks tool outputs crossing the trust boundary as tainted, propagates taint
  monotonically across a run, and keeps a value-level provenance graph; policy rules gate on
  `whenTainted`.
* **`buildTrace`** — turns a run's event stream into an ordered, replayable audit trace (per-step
  explanations + run totals). Exposed via `GET /api/runs/:id/trace` and the Governance panel.

See [SECURITY.md](SECURITY.md).

### 5.14 Verification (`core/src/verification`)
Evidence-based completion checking so "done" rests on evidence, not optimism. `runCheck` executes
pluggable checks — `test` (a real shell command; exit 0 = pass), `schema` (JSON-schema validation of
output), `assertion` (substring/regex/predicate), `critic` (reuses the Jev decision engine
`decisions.noul` as an LLM judge — no mock) — each returning a 0..1 confidence and a reason. The
`Verifier` aggregates per-check confidences into one score; when it is below
`verification.confidenceThreshold` the run is **escalated for human review** (persisted) rather than
silently passing. Wired into the runtime as `m.verifier`; API `GET /api/verifications[/:id]`,
`POST /api/verify`, `GET /api/escalations`, `POST /api/escalations/:id/resolve`; **Verification**
panel. Present by default but every check is opt-in per step, so existing flows are unchanged. Config
`verification`.

### 5.15 Reliability engineering (`core/src/reliability/{regression,chaos,slo}.ts`)
Turns real runs into regression tests, injects controlled faults, and tracks per-agent SLOs — distinct
from the low-level primitives of §5.10, which it builds on. `RunRecorder` snapshots a real run
(input, tool calls, output, model) and `ReplayService` re-runs it through the live agent, diffing
status, tool sequence and output similarity to flag regressions. `ChaosController` deterministically
(seedable) injects failures/timeouts/latency into the **real** tool-execution path
(`core/src/tools/executor.ts`), gated by a tool-glob allowlist, to prove retries/circuit-breakers/sagas
degrade gracefully — **off by default** (`reliability.chaos.enabled = false`). `SloService` computes
success rate, intervention/escalation rate and cost-per-task per agent over a window from the real run
history, flagging target breaches. Wired as `m.runRecorder`, `m.replay`, `m.chaos`, `m.slo`; API
`GET /api/slo|chaos|recordings`, `POST /api/recordings[/:id/replay]`, `DELETE /api/recordings/:id`;
CLI `mercury reliability`; **Reliability** panel. Config `reliability`.

### 5.16 Proactive (`core/src/proactive`)
An event-trigger framework so the agent reacts to the world without being annoying. `EventSource`s
produce events — `GatewayEmailSource` subscribes to the existing gateway's `gateway.inbound` event
(real inbound email), `WebhookSource` ingests generic webhook/CI events via
`POST /api/proactive/events`. Declarative rules (source/kind glob + substring) map an event to an
optional agent action and a base priority. The interrupt-timing model `scorePriority` scores each
event 0..1 (urgent/security/CI-fail signals raise it, newsletters/FYIs lower it); events at/above
`proactive.interruptThreshold` **interrupt** immediately (deliver + run action), the rest are
**deferred** into a digest queue. `ProactiveService.flushDigest` bundles the deferred queue into one
digest, delivered on a cron (`proactive.digestCron`) by **reusing the Scheduler** (a sentinel job).
Wired as `m.proactive`; API `GET /api/proactive`, `POST /api/proactive/events|digest/flush|poll`;
CLI `mercury proactive`; **Proactive** panel. **Disabled by default.** Config `proactive`.

### 5.17 Learning from runs (`core/src/learning`)
The agent learns from its own completed runs, driven entirely by the real `runs` table and the
`EventBus` (no external state). The `LearningService` subscribes to `run.end` and does three things,
each independently toggleable and all **off at the master switch by default** (`learning.enabled =
false`):
* **1a Experience hints** — `hintFor(task, userId?)` finds the most similar past *successful* run(s)
  by cheap token-overlap (Jaccard) similarity and distils a short "Learned from past runs" hint that
  the agent injects into the run-start context via its system prompt. No sufficiently similar run →
  no hint. Config `learning.hints` (`enabled`, `maxExamples`, `minSimilarity`, `lookback`).
* **1b Auto-tuned routing** — each finished run upserts a `(difficulty bucket, model)` row (runs,
  successes, cost, tokens) into `learning_route_stats`. As the router's `RouteLearner` (§5.3),
  `suggest()` returns the model with the best observed success rate for a bucket once it clears
  `routing.minSamples` and `routing.minSuccessRate` (ties broken by lower average cost); otherwise it
  returns `null` and the router keeps its economics/decision choice. Config `learning.routing`.
* **1c Failure playbooks** — recurring error signatures (normalised by `errorSignature`, which strips
  ids/numbers/quoted paths/hex) are recorded in `learning_playbooks`; when a later similar task
  succeeds, what worked is stored as that signature's remediation. `playbookForTask` /
  `playbookForError` surface a remediation (with enough occurrences and task similarity) on the next
  matching task or failure. Config `learning.playbooks` (`enabled`, `minOccurrences`, `minSimilarity`).

Persistence is **migration #6**: `learning_route_stats` (PK `(bucket, model)`) and `learning_playbooks`
(unique `signature`), both indexed. Wired as `m.learning` (started/stopped with the runtime, attached
to the router via `setLearner`); reads are exposed via `GET /api/learning[/stats|/playbooks|/hint]` and
the CLI `mercury learn stats|hints|playbooks`; the admin **Learning** panel renders status, the routing
table and the playbooks. Learning must never break a run — recording is wrapped so a failure is
swallowed. Config `learning`.

### 5.18 Curated MCP presets (`packages/mcp/src/presets.ts`)
Ready-to-use `McpServerConfig`s for well-known reference MCP servers (`filesystem`, `fetch`, `github`,
`git`, `sqlite`), each with a safe default policy (`trust: 'untrusted'` so output is spotlighted,
sampling off) and **no hardcoded secrets** — anything sensitive is a `${ENV_VAR}` placeholder listed in
`requiredEnv`. `mercury mcp presets` lists them; `mercury mcp enable <preset>` resolves the placeholders
from the environment (`resolvePreset`, reporting any still-missing env vars) and writes the concrete
config under `mcp.servers.<name>`, after which the existing MCP client subsystem (§5.6) connects to it
like any user-defined server. Only the resolved config is ever written — the preset itself never holds a
secret value.

---

## 6. Extension points

| Extension | Interface | Discovery |
|---|---|---|
| Tool (TS/JS) | `Tool` | `~/.mercury/tools/*.js`, `./.mercury/tools`, plugins |
| Tool (any language) | `tool.json` + executable | `tools/`, `~/.mercury/tools/<name>/` |
| Skill | `SKILL.md` | `skills/`, `~/.mercury/skills`, `./.mercury/skills`, git |
| Workflow | YAML/JSON spec or `WorkflowTemplate` class | `workflows/`, `~/.mercury/workflows` |
| Pattern | `Pattern` | plugins, `~/.mercury/patterns/*.js` |
| LLM provider | `LLMProvider` | config `providers`, plugins |
| Decision provider | `DecisionProvider` | plugins |
| Adapter | `Adapter` (extends `BaseAdapter`) | `~/.mercury/adapters/*.js`, plugins |
| Plugin | `Plugin { setup(api) }` | `~/.mercury/plugins/*`, config `plugins` |
| Memory provider / context engine | `MemoryProvider`, `ContextEngine` | plugins |
| Personality | `*.md` | `personalities/`, `~/.mercury/personalities` |
| Add-In (tools/personalities/profiles) | declarative files + manifest | `<dataDir>/addins/*` |
| Permission profile | declarative policy (name→policy map or single policy) | `<dataDir>/permissions/*` |
| Hooks | `HookName` handlers | plugins, config `hooks` (webhook/log) |

Scaffolding: `mercury new tool|skill|workflow|adapter|plugin <name>`.

---

## 7. Security model (summary)

Principals: `admin`, `user`, `api_client` (API tokens with scopes). Trust levels for content:
`system > user > trusted_tool > untrusted`. Guardrails run on input, tool calls and output;
external content is spotlighted inside `<untrusted_content>` markers with an instruction
hierarchy in the system prompt; sensitive tools derived from untrusted content require approval;
terminal commands pass dangerous-pattern detection and approval; file tools are jailed; web tools
are SSRF-protected; secrets are redacted from logs/outputs; an append-only hash-chained audit
log records security-relevant actions. Governance adds least-privilege time-limited credential
**grants** (no standing keys), **policy-as-code** (`allow`/`deny`/`approve`, strictest wins) before
sensitive actions, **taint tracking** of untrusted tool output, and a **replayable audit trail**
(§5.13). **Verification** (§5.14) adds a human-in-the-loop safety net — low-confidence completions are
escalated for review instead of passing silently; **chaos** fault injection (§5.15) is **off by
default** and gated by a tool-glob allowlist so it can only run deliberately. The gated `web_read`
tool (§5.6) is `sensitive` and always requires approval, so opening an arbitrary web page is subject
to the same approval/policy/audit path (and its output is tainted) as any other sensitive action.
Full threat model: [SECURITY.md](SECURITY.md).

---

## 8. Data directory layout (`~/.mercury`, override with `MERCURY_HOME`)

```
~/.mercury/
├─ config.yaml        user config (layer 2)         ├─ .env            secrets (layer 3)
├─ mercury.db         SQLite (users, sessions, messages, facts, usage, schedules, events, audit…)
├─ users/<id>/        MEMORY.md, USER.md             ├─ attachments/    uploaded files
├─ skills/ tools/ workflows/ plugins/ adapters/ personalities/ patterns/   user extensions
├─ checkpoints/<session>/<n>/                        ├─ mcp.json        external MCP servers (hot reload)
└─ secret.key         JWT signing key (generated, 0600)
```

---

## 9. Hermes Agent feature-parity matrix

| Hermes feature | Mercury module | Notes |
|---|---|---|
| Toolsets, 40+ tools, enable/disable per platform, `hermes tools` | `packages/tools/src/builtin/*`, `core/src/tools/registry.ts`, `mercury tools` | 55+ tools in 14 toolsets |
| `execute_code` (script calling tools via RPC) | `packages/tools/src/sandbox/execute-code.ts` | child process, JSON-RPC over stdio, timeout, env scrub |
| Image generation (pluggable) | `packages/tools/src/builtin/media.ts` (`image_generate`) | mock (SVG) default, OpenAI-compatible provider |
| Skills, progressive disclosure, agentskills.io | `core/src/skills/*` | `skills_list`, `skill_view` |
| Autonomous skill creation / self-improvement | `core/src/reflection/reflector.ts`, `skill_create`, `skill_update` | success stats in `skill_stats` |
| `/skills`, `/<skill-name>` | `core/src/agent/commands.ts` | |
| Skill hub / install from folder or git | `core/src/skills/installer.ts`, `mercury skills install` | |
| MEMORY.md / USER.md bounded memory | `core/src/memory/curated.ts` | char limits configurable |
| FTS5 session search + LLM summarization | `core/src/memory/episodic.ts`, `search_sessions` | |
| User modeling (Honcho-like) | `core/src/memory/user-model.ts` | dialectic observations → traits |
| Pluggable external memory providers | `core/src/memory/providers.ts` | plugin API |
| Messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal, Email, Matrix, HA, webhooks) | `packages/gateway/src/adapters/*` | + Mattermost, Teams, IRC, SMS, RSS, web chat, CLI |
| DM pairing codes | `core/src/auth/pairing.ts`, `gateway/src/gateway.ts` | |
| Cross-platform continuity | `gateway/src/gateway.ts` (`continuity: per-user`) | |
| Voice memo transcription | `gateway/src/gateway.ts` + `core/src/voice` | |
| Cron scheduler (NL + cron, skills, delivery, pause/resume/edit) | `core/src/scheduler/*` | |
| Subagent delegation (`delegate_task`, isolated, restricted toolsets, parallel) | `core/src/workflows/spawner.ts`, `packages/tools/src/builtin/agents.ts` | max 3/agent, max depth |
| MCP client (stdio, HTTP, SSE, filtering, sampling) | `packages/mcp/src/client.ts` | hot reload of `mcp.json` |
| Voice mode, STT/TTS (whisper, OpenAI, Edge/piper, custom CLI) | `core/src/voice/*`, CLI `/voice`, web mic | wake-word hook interface |
| Vision / image input / attachments | `core/src/attachments/*`, `llm` content parts | |
| Browser automation (local, CDP, cloud) | `packages/tools/src/browser/*` | Playwright if installed; fetch-based fallback |
| Terminal backends (local, Docker, SSH, plugins) + approvals | `packages/tools/src/terminal/*`, `core/src/security/commands.ts` | |
| Context files (AGENTS.md, CLAUDE.md, SOUL.md, .cursorrules…) | `core/src/agent/context-files.ts` | |
| `@file` `@folder` `@diff` `@url` references | `core/src/agent/references.ts` | jail + SSRF + untrusted tagging |
| Filesystem checkpoints, `/rollback` | `core/src/checkpoints/checkpoints.ts` | |
| Plugin architecture (hooks, memory providers, context engines) | `core/src/plugins/*` | |
| Event hooks (logging, alerts, webhooks, interception, metrics, guardrails) | `core/src/plugins/hooks.ts`, `core/src/plugins/builtin-hooks.ts` | |
| Context compression `/compress` | `core/src/agent/compression.ts` | |
| `/usage`, `/insights` | `core/src/agent/insights.ts` | |
| Personalities, SOUL.md | `core/src/agent/personalities.ts` | |
| Slash commands `/new /reset /model /retry /undo /stop /compress /usage /insights /skills /rollback /help` | `core/src/agent/commands.ts` | |
| CLI: chat, model, tools, config, gateway, setup, update, doctor, plugins | `packages/cli/src/commands/*` | |
| `hermes claw migrate` style import | `mercury import-agent` (imports `~/.hermes`) | |
| CLI extras: user, token, schedule, skills, mcp, serve, help, new | `packages/cli/src/commands/*` | |

Mercury-only additions: Jev decision engine, reasoning patterns, multi-agent workflow templates
(including the `planner-executor` template), learning from runs (experience hints, auto-tuned routing,
failure playbooks), skill composition, curated MCP presets, a gated `web_read` tool, RBAC/ABAC + API
tokens, token budgets, MCP *server*, hash-chained audit log, debug breakpoints and run replay, web UI,
i18n, polyglot tool protocol.
