# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-11-23

### Security
- Ownership checks on run-scoped endpoints (stop, feedback, replay, time-travel, state, events, trace, debug resume), approvals (owner or admin; admin-only approvals for host execution by non-admins), team runs, task budgets, schedules and verification records.
- Pairing approval requires `gateway.manage`; already linked identities are only moved with `relink`.
- Password change requires the current password and revokes earlier JWTs; disabling/demoting a user revokes their JWTs; last-admin guard; per-account login lockout (10 failures / 15 min → 429); API tokens expire after `auth.apiTokenMaxTtlDays` (default 365); atomic first-admin bootstrap.
- Host-execution gate (`tools.hostAccess.nonAdmin`, default `approve` = admin approval), scrubbed command environment (`tools.terminal.envPassthrough`), data-dir jail, extra command-risk patterns, ssh option-injection guard, hardened docker run flags, process-group kill on timeout/stop.
- SSRF guard covers RFC 6890 and IPv6-embedded IPv4, pins DNS, and re-validates redirects.
- WhatsApp/Facebook webhooks fail closed without `appSecret` (`allowUnsigned` for local testing); webchat requires long random visitor ids.
- HTTP hardening: CSP/XFO/nosniff headers, `no-store` for API/metrics/webhooks, attachments served as downloads unless inert media, generic 5xx bodies, `/health` reports the real version, `/metrics` gated (`observability.metricsToken`, loopback or admin).
- Proactive actions are tainted; reserved `__name__` schedules; auto playbooks are per user; automatic skill creation/refinement only for admin runs; spawner limits can only be tightened; MCP `readOnlyHint` honoured only for trusted servers; safe git sources for skill installs; add-in paths resolved with realpath; random local admin password; keyed (HMAC) audit chain (`audit.key`); budget rules for user `system` cap auxiliary calls.
- Auxiliary (system-principal) LLM calls made inside a user's agent/team run are checked against and charged to that user's budget; approval-gate decisions stay exempt.
- JSON-schema tools enforce `additionalProperties: false`, numeric bounds, string length and `maxItems` (also after hook rewrites).
- Tools that ignore cancellation are tracked as runaway (`tool.runaway` event + audit); new calls are refused while 2 are still running.
- `execute_code` can run in a locked-down container (`tools.executeCode.backend`: `auto` | `host` | `docker`; no network, no capabilities, read-only, nobody user).
- Opt-in automatic verification of completed top-level runs (`verification.autoVerify`).
- Polyglot tools can run in a locked-down container (`tools.polyglotBackend`: `auto` | `host` | `docker`; tool.json `image`, `network`, `workdir`).
- Polyglot tools whose folder is writable through the path jail are host-gated (`tools.hostAccess.nonAdmin`) and tamper-pinned (folder fingerprint at load; changed files → call refused).
- Host-specific `deploy/14444ce25a.conf` replaced by a generic `deploy/nginx.conf.example`.
- Deployment: systemd unit sandboxing, nginx no longer adds a shared-cache directive, docker-compose binds 127.0.0.1.

### Changed (tooling)
- `npm run typecheck` / `npm run lint` now also type-check the test suite (`tsconfig.tests.json`); 20 latent type errors in existing tests fixed.
- Removed unused variables/imports so `npm run lint` reports zero warnings.

### Changed (behaviour)
- Non-admin `terminal`/`process_start`/`execute_code` calls now need an admin's approval (set `tools.hostAccess.nonAdmin: allow` for the previous behaviour).
- Auxiliary usage triggered by a user's run now appears under that user (kind `auxiliary`) instead of `system`.
- With `tools.terminal.backend: docker`, `execute_code` now also runs in docker (`tools.executeCode.backend: host` restores host execution).
- `POST /api/schedules` without `when`/`task` returns 400 instead of 500.
- With `tools.terminal.backend: docker`, python/node polyglot tools (or tools with an `image`) now run in docker without network (`tools.polyglotBackend: host` restores host execution).
- Polyglot tools in folders inside a jail root (e.g. the bundled tools when Mercury runs from a checkout in its working directory) now count as host execution for non-admins and refuse to run after their files change until Mercury is restarted.

## [1.4.0] - 2026-11-22

### Added
- **Governed long-term memory & knowledge layer.** The existing memory subsystem is now policy-governed, PII-aware, retention-bounded, namespaced, and auditable. Writes and reads can be routed through the policy engine (`memory.governance.enforcePolicy`), PII is detected and either redacted or blocked (`memory.governance.pii.*`), facts are scoped to namespaces on top of the per-user scope, and retention limits (`memory.retention.ttlDays`, `memory.retention.maxItemsPerNamespace`) prune automatically. Every governed decision is recorded in a new queryable `memory_audit` ledger (in addition to the global audit bus). A new knowledge/RAG store ingests documents, chunks and embeds them, and recalls with full provenance via hybrid FTS+vector search; knowledge grounds `buildContext()` when `memory.knowledge.enabled`. Memory config is now a shareable bundle section, and evals can quantify memory lift. Governance is OFF/soft by default and all existing memory signatures remain backward-compatible.
- **Multi-agent orchestration (teams).** A new `teams` core module composes named, persisted teams of roles/agents with a strategy (coordinator→workers, pipeline, or debate). Teams delegate subtasks by reusing the spawner and blackboard, aggregate the results, and degrade gracefully when a member fails (one member failing never crashes the run). Runs are governed (per-run budget ceiling, optional approval gate, policy checks) and fully auditable; team definitions and run records are persisted. Disabled by default (`teams.enabled: false`).
- CLI: `mercury memory <remember|recall|forget|ns|knowledge add|knowledge search|audit>` and `mercury team <list|create|show|delete|run|runs>`.
- REST: auth-gated `/api/memory/{namespaces,audit,knowledge}` and `/api/teams/*` endpoints.
- Admin web panels for the knowledge/governance view and for teams.
- EN + DE i18n strings and EN + DE help topics for both features.


## [1.3.0] - 2026-11-21

### Added
- **Evaluation-driven self-improvement** (`packages/core/src/evals/`, harness on by default under
  `evals.enabled`; auto-tuning OFF by default under `evals.autotune.enabled`).
  - Closed eval cases are promoted from real (or 👍-rated) run traces into labeled cases capturing
    the input and the expected tools / output substrings / cost ceiling (`mercury.evals.promoteRun`).
  - A deterministic, scored regression gate runs a suite of cases and aggregates a weighted score
    over pass-rate, cost-per-task, intervention-rate and output-similarity (weights configurable
    under `evals.weights`). Scores are persisted (retention `evals.retainScores`) and trendable.
  - A governed auto-tuner proposes changes (model routing, pattern, temperature, skill
    promote/retire, prompt), measures each proposal against the suite, and keeps ONLY changes that
    improve the aggregate score by at least `evals.autotune.minImprovement` without breaking the
    per-task budget ceiling (`evals.costCeiling`) or touching governance-protected config
    (`security.*`, `governance.*`, `approvals.*`, `policies.*`). Proposals auto-apply only when both
    `evals.autotune.enabled` and `evals.autotune.autoApply` are set.
  - Accepted tunes are versioned and reversible: each records the previous values and can be reverted
    (`mercury.evals.revertTune`).
  - Facade `mercury.evals`, REST `/api/evals/*` (auth-gated), and an admin **Evaluations & Auto-tune**
    panel in the web UI (EN + DE i18n). Config under `evals`.
- **Sharable Agent Bundles** ("Mercury packs", `packages/core/src/bundles/`, on by default under
  `bundles.enabled`).
  - A single versioned, signed artifact bundles skills + workflows + personality + policy + MCP
    presets. Export the current config (any subset of sections) to a bundle file
    (`mercury.bundles.export` / `exportToFile`), and install it into another instance in one command
    or endpoint (`mercury.bundles.install`).
  - Integrity: bundles carry a format version and an HMAC-SHA256 signature; install verifies the
    signature (tamper detection) and checks version/compatibility before applying. Installs are
    idempotent (re-installing the same bundle digest is a no-op).
  - Governance: installing policy or MCP preset sections goes through the same approval/governance
    path (queued unless `bundles.autoApprovePolicy` / `bundles.autoApproveMcp`), never silently.
  - Facade `mercury.bundles`, CLI `mercury bundle export|inspect|install`, REST `/api/bundles/*`
    (auth-gated), and an admin **Agent Bundles** panel in the web UI (EN + DE i18n). Config under
    `bundles`.

### Changed
- Version bumped to 1.3.0 across all workspace packages.

## [1.2.0] - 2026-11-21

### Added
- **Self-distilling skills** (`packages/core/src/skills/`, off by default under `skills.distill.enabled`).
  - The agent distils reusable, *parameterized* skills from its own successful (or 👍-rated) run
    traces: the proven tool sequence is captured and concrete values are generalized into named
    parameters. Distillation triggers on run success and on positive (👍) feedback.
  - Governance: newly distilled skills land in a review queue (`status: proposed`) and must be
    approved before use, unless `skills.distill.autoApprove` is set. Skills are versioned; a
    sufficiently similar new trace updates the existing skill (dedup by `dedupMinSimilarity`)
    rather than creating a duplicate.
  - Promote/demote by evidence: approved skills accrue success-rate and average-cost stats and are
    auto-retired once they fall below `retireBelowSuccessRate` after at least `minRunsBeforeRetire`
    uses. A hard cap (`maxSkills`) prunes the oldest retired skills.
  - Reuse: when an incoming task matches an approved skill (≥ `matchMinSimilarity`), the proven
    path surfaces to the agent as a "proven skill" plan hint so it can execute the known-good
    procedure instead of re-deriving it.
  - REST `/api/distilled-skills` (list / `:id/approve` / `:id/retire`, auth-gated) and an admin
    **Distilled Skills** panel in the web UI (EN + DE i18n). Config under `skills.distill`.
- **Deterministic run replay & time-travel debugging** (`packages/core/src/timetravel/`, on by
  default under `replay.enabled`).
  - Every run's bus-event stream is persisted as a per-run trace (new `run_traces` table,
    migration #8) capturing input, seed, steps and lineage.
  - Time-travel: list traced runs, scrub the timeline, and inspect the reconstructed state
    (LLM/tool-call counts, cost, tokens, taint) at any step.
  - Fork & re-run: edit an input and "re-run from here" — a new linked run (`parent_run_id` +
    `from_step`) reuses the upstream prefix and deterministically recomputes everything downstream.
    Governance/approvals still apply on the recomputed portion.
  - Mercury facade `mercury.traces` (`getTrace`, `getStateAt`, `listTraces`, `replayFrom`), REST
    `GET /api/traces`, `GET /api/runs/:id/timetravel`, `GET /api/runs/:id/state?step=N`,
    `POST /api/runs/:id/replay {fromStep, edits}`, and an admin **Run Replay** panel in the web UI
    (EN + DE i18n). Config under `replay` (`enabled`, `retainTraces`, `persistDeltas`).

### Changed
- Scheduler: the task description field in the schedule edit form is now a multi-line textarea
  (easier to read and edit longer task instructions).

## [1.1.1] - 2026-11-21

### Added
- **Learning from runs** (`packages/core/src/learning/`, off by default under `learning.enabled`).
  - Experience hints: at run start the agent is given a short hint distilled from the most similar
    past *successful* run (graceful empty when nothing is similar enough).
  - Auto-tuned routing: observed success rates per (difficulty bucket, model) are fed back to the
    model router, which prefers a learned model only once there are enough samples and otherwise
    falls back to `router.economics`. Learning-adjusted decisions are flagged `adjustedByLearning`.
  - Failure playbooks: recurring error signatures and the remediation that later worked are
    persisted (new `learning_route_stats` and `learning_playbooks` tables, migration #6).
  - CLI `mercury learn <stats|hints|playbooks>`, read endpoints under `/api/learning*` (auth-gated),
    and an admin **Learning** panel in the web UI (EN + DE i18n).
- **Skill composition** (`packages/core/src/skills/composer.ts`): a skill can invoke other skills
  and tools as a small cached pipeline, with a hard depth limit and cycle detection (recursion
  guard) and a per-composition step budget. Exposed as the `skill_compose` tool. Config under
  `composition` (on by default; bounded cache).
- **Curated MCP presets** (`packages/mcp/src/presets.ts`): `filesystem`, `fetch`, `github`, `git`,
  `sqlite`, using env-var placeholders (no secrets). Discover/enable via
  `mercury mcp <presets|status|enable>`.
- **Gated web reader** (`web_read`): HTML-to-main-content extraction behind the existing SSRF guard
  and approval/policy/audit path; risk `moderate`, sensitive, untrusted output. Two interchangeable
  backends share the one extraction pipeline — the default **HTTP** backend (no JavaScript) and an
  opt-in **headless-browser** backend (`render=true`, or `tools.web.render`) that renders the live
  DOM through `tools.browser.backend` (playwright/cdp) for client-rendered pages, SSRF-validating the
  entry URL first and degrading to HTTP when no browser backend is installed.
- **Planner-executor workflow** (`planner-executor`): decomposes a task into several steps, executes
  them in order feeding results forward, re-plans once on failure, then synthesises — with
  configurable `minSteps`/`targetSteps`/`maxSteps` and a hard cap (config `workflows.planner`).
  Emits `workflow.step` per step so progress is observable. Addresses workflows terminating too
  quickly.

### Changed
- Help system: added a `learning` topic and documented the planner-executor template, MCP presets
  and the `web_read`/`skill_compose` tools, with matching German translations for the new/updated
  topics (and the previously-missing German UI nav/panel strings).
- Bumped all packages to 1.1.1.

## [1.0.1] - 2026-11-20

### Fixed
- **execute_code sandbox no longer crashes the server on a closed RPC pipe.** When a
  sandboxed script made a tool call and then exited (or was killed on timeout) before the
  parent wrote the reply back over the fd-3 socket, the write failed with `EPIPE`. The
  readline Interface over that socket re-emits the error on itself, so the unhandled
  `'error'` event took down the whole `mercury serve` process. Replies to the child are now
  written through a guarded helper that treats a closed/destroyed pipe as a no-op, and the
  readline Interface has its own error handler. Added `tests/sandbox.test.ts` with a
  regression test that reproduces the race.

## [1.0.0] - 2026-11-20

First stable major release, consolidating the five frontier-autonomy feature areas (economics & routing, governance & security, built-in verification, reliability engineering, proactive event triggers).

### Added
- **Economics & routing — spend the least money likely to succeed, with hard per-task budgets
  and a live cost-vs-value readout.** Builds on the existing model router and budgets subsystem;
  all config is backward-compatible (new keys default to sensible values).
  - **Cheapest-model-likely-to-succeed selection with local vs frontier lanes.** Each model
    profile gains a `lane` (`local` | `frontier` | `default`). The router infers a task's likely
    difficulty from cheap offline signals (`inferDifficulty`) and picks the cheapest model whose
    quality tier clears that bar (`selectCheapestSufficient`): routine tasks may use the near-zero-cost
    local lane, while harder tasks exclude local so real reasoning goes to frontier/default models.
    Configure under `router.economics` (`enabled`, `localLaneMaxDifficulty`, `qualityMargin`). The
    route decision now also reports the chosen `lane` and `qualityNeed`.
  - **Hard per-task budgets with halt/escalate on exceed.** A new `TaskBudgetService` enforces a
    cost/token ceiling scoped to a single task/run (distinct from the recurring per-user/per-model
    quotas). The `LLMService` checks the task budget before every model call; exceeding it throws a
    `TaskBudgetExceededError` and the task is halted or escalated per `budgets.perTask.onExceed`.
    Configure under `budgets.perTask` (`enabled`, `maxCost`, `maxTokens`, `onExceed`, `projectedSteps`).
  - **Running cost-vs-value estimate** exposed via `GET /api/tasks` / `GET /api/tasks/:id` and a new
    card in the **Models & budgets** Web UI panel: cost so far, projected final cost, configured task
    value, value/cost ratio, budget-used fraction and an over-budget flag.
- **Governance & security — least-privilege grants, policy-as-code, prompt-injection taint tracking
  and a replayable audit trail.** Extends the existing permissions, injection-defense and
  event-stream subsystems; disabled paths stay backward-compatible.
  - **Least-privilege per-task credential grants (no standing keys).** A new `GrantBroker` issues
    scoped, time-limited `Grant`s bound to a task; a sensitive capability is denied
    (`GrantDeniedError`) unless a live grant exists. Grants have a TTL (clamped to
    `security.grants.maxTtlMs`), optional use caps, and can be revoked individually or per task.
    Ephemeral credentials are minted against a grant and kept only in memory for its lifetime —
    never persisted — and vanish the instant the grant expires or is revoked. Tools opt in via a
    `capability` (and optional `capabilityScope`) declaration. API: `GET/POST /api/grants`,
    `DELETE /api/grants/:id`.
  - **Policy-as-code enforced before sensitive actions.** A new `PolicyCodeEngine` evaluates
    declarative rules (config-driven, with a built-in payment-cap and external-email rule set) that
    yield `allow` / `deny` / `approve`; the strictest effect wins. The tool executor blocks `deny`
    and forces an approval gate on `approve` — even in auto mode — before the action runs. Configure
    under `security.policies` (`builtins`, `paymentApprovalThreshold`, `currency`,
    `allowedEmailDomains`, custom `rules`). API: `GET /api/policies`, `POST /api/policies/test`.
  - **Prompt-injection taint tracking of tool outputs.** A new `TaintTracker` marks tool outputs
    that cross the trust boundary as tainted (scanning them with the existing injection scanner),
    propagates taint monotonically across a run, and maintains a value-level provenance graph.
    Policy rules can gate on taint (`whenTainted`) so a sensitive action driven by untrusted content
    is routed to approval or blocked.
  - **Replayable audit trail ("why did you do that?").** A new `buildTrace` turns a run's recorded
    event stream into an ordered, human-readable trace (per-step explanations plus run-level totals:
    cost, tokens, LLM/tool/decision counts, taint, duration). Exposed via `GET /api/runs/:id/trace`
    and a new **Governance** Web UI panel that also manages grants and tests policies.
- **Built-in verification — evidence-based completion checks with a confidence score and
  human-review escalation.** A new verification subsystem (`packages/core/src/verification/`) runs
  pluggable evidence checks after a task and decides, on evidence rather than optimism, whether the
  work is actually done. Backward-compatible: the subsystem is present by default but every check is
  opt-in per step, so existing flows are unchanged.
  - **Pluggable evidence checks** (`test`, `schema`, `assertion`, `critic`). `test` runs a real shell
    command and treats a zero exit as passing; `schema` validates output against a JSON schema;
    `assertion` checks substring/regex/predicate expectations; `critic` reuses the existing decision
    engine (`decisions.noul`) as an LLM judge — no mock. Each check yields a 0..1 confidence with a
    human-readable reason.
  - **Aggregate confidence + escalation.** The `Verifier` combines per-check confidences into a single
    0..1 score; when it falls below `verification.confidenceThreshold` the run is escalated for human
    review (persisted, not silently passed). API: `GET /api/verifications`, `GET /api/verifications/:id`,
    `POST /api/verify`, `GET /api/escalations`, `POST /api/escalations/:id/resolve`, and a new
    **Verification** Web UI panel. Config under `verification`.
- **Reliability engineering — record/replay regression, chaos fault injection and per-agent SLOs.**
  A new subsystem (`packages/core/src/reliability/{regression,chaos,slo}.ts`) that turns real runs
  into regression tests, injects controlled faults to prove graceful degradation, and tracks
  per-agent service-level objectives. All opt-in; chaos is **off by default**.
  - **Record / replay as regression tests.** `RunRecorder` snapshots a real run (input, tool calls,
    output, model) and `ReplayService` re-runs it through the live agent, diffing status, tool
    sequence and output similarity to flag regressions. API: `GET/POST /api/recordings`,
    `POST /api/recordings/:id/replay`, `DELETE /api/recordings/:id`; CLI `mercury reliability record|recordings|replay`.
  - **Chaos fault injection (off by default).** `ChaosController` deterministically (seedable) injects
    failures, timeouts and latency into the real tool-execution path, gated by a tool glob allowlist,
    to verify retries/circuit-breakers/sagas hold. Config under `reliability.chaos` (`enabled` defaults
    to `false`). API: `GET /api/chaos`; CLI `mercury reliability chaos`.
  - **Per-agent SLOs.** `SloService` computes success rate, intervention/escalation rate and
    cost-per-task per agent over a window from the real run history, flagging breaches against
    configured targets. API: `GET /api/slo`; CLI `mercury reliability slo`; new **Reliability** Web UI
    panel.
- **Proactive (but not annoying) — event triggers, interrupt-vs-defer timing and digest batching.**
  A new subsystem (`packages/core/src/proactive/`) that lets the agent react to real-world events
  (new email, failing CI build, …) through declarative rules, deciding when to interrupt the user
  immediately versus batch low-priority updates into a periodic digest. Disabled by default.
  - **Event-trigger framework with concrete, non-mocked sources.** Event sources produce events that
    declarative rules (source/kind glob + substring) map to an optional agent action and a base
    priority. `GatewayEmailSource` reacts to real inbound email via the existing gateway's
    `gateway.inbound` event; `WebhookSource` ingests generic webhook/CI events via
    `POST /api/proactive/events`.
  - **Interrupt-timing priority model.** `scorePriority` scores each event 0..1 (urgent/security/CI-fail
    signals raise it, newsletters/FYIs lower it); events at/above `proactive.interruptThreshold` notify
    immediately, the rest are deferred. A rule may force `interrupt` or `digest`.
  - **Digest batching via the scheduler.** Deferred low-priority events accumulate and are bundled into
    one digest delivered on a cron (`proactive.digestCron`), reusing the existing Scheduler rather than
    interrupting. API: `GET /api/proactive`, `POST /api/proactive/events|digest/flush|poll`; CLI
    `mercury proactive`; new **Proactive** Web UI panel. Config under `proactive`.
- **Three new native gateway adapters**, bringing the built-in total to 19:
  - **facebook** — Facebook Messenger, bidirectional. Inbound via the Meta Messenger webhook
    (GET verification handshake + HMAC-verified POSTs, `x-hub-signature-256`), outbound via the
    Graph Send API. Config: `pageId`, `token`, `verifyToken`, `appSecret`
    (`FACEBOOK_PAGE_ID` / `FACEBOOK_PAGE_TOKEN` / `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET`).
  - **x** — X (Twitter) Direct Messages, bidirectional. Inbound via the Account Activity API
    (auto CRC challenge-response + `x-twitter-webhooks-signature` verification), outbound via
    API v2 DMs. Config: `consumerSecret`, `token`, `botUserId`
    (`X_CONSUMER_SECRET` / `X_BEARER_TOKEN` / `X_BOT_USER_ID`).
  - **linkedin** — LinkedIn, **outbound only** (publishes `PUBLIC` UGC shares via `POST /ugcPosts`);
    LinkedIn exposes no general inbound messaging webhook for standard apps. Config: `token`,
    `authorUrn` (`LINKEDIN_TOKEN` / `LINKEDIN_AUTHOR_URN`).
  - Added `hmacBase64()` and `verifyXSignature()` security helpers in `@mercury/core` to support
    the X CRC and webhook signature checks.

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

[Unreleased]: https://github.com/ms1963/mercury_agent/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/ms1963/mercury_agent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ms1963/mercury_agent/compare/v0.7.0...v1.0.0
[0.3.0]: https://github.com/ms1963/mercury_agent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ms1963/mercury_agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ms1963/mercury_agent/releases/tag/v0.1.0
