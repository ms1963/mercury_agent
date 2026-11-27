![Mercury Agent](../assets/mercury_agent.png)

# Mercury vs Hermes Agent — Capability Gaps

**What this document is.** A grounded, command-level diff between **Hermes Agent** (Nous Research;
the real installation present on this machine) and **Mercury Agent** (this repository at **v2.1.0**).

**How it was produced (honesty note).**

- The **Hermes** side is the actual `hermes --help` command surface of the installed Hermes Agent
  (Nous Research) — its subcommands, read directly from the binary on this host.
- The **Mercury** side is the actual `mercury help` command surface of this repository at HEAD.
- This is a **presence-of-capability diff** (does a command/subsystem exist), **not** a measurement of
  depth or quality of each implementation, and **not** a runtime benchmark. No Hermes internals were
  inspected beyond its public CLI surface.
- This complements [COMPARISON.md](COMPARISON.md). That document is written against a "parity
  positioning reference"; **this** document is written against the real Hermes CLI, so where the two
  disagree, trust this one for *what is missing*.

---

## 1. Genuine functional gaps (Hermes has it; Mercury lacks it or has only a partial form)

| # | Area | Hermes command/feature | Mercury today | Gap |
|---|---|---|---|---|
| 1 | **Native desktop app** | `desktop` / `gui` (build & launch native app) + `serve` headless backend powering it | Web UI (`serve`) only | Missing native desktop shell |
| 2 | **Computer Use / GUI automation** | `computer-use` (cua-driver; macOS/Windows/Linux) | Untested Playwright browser backend only | No OS-level GUI control |
| 3 | **Mixture-of-Agents** | `moa` (aggregate answers across several model slots) | ✅ **Done** — `mercury moa "<prompt>"` fans the SAME prompt out to several proposer model slots in parallel, collects their proposals, and produces one final answer by `synthesize` (an aggregator model slot writes the final answer from all proposals) or `vote` (majority / self-consistency; ties broken by first appearance). A natural extension of the Jev router + teams: it reuses the existing model-slot / LLM-gateway call path (routing, RBAC, budgets, usage ledger) via an injected runner (`m.moaModelCall`) rather than adding a second LLM mechanism. Proposer/aggregator slots and strategy are configurable via flags or the new `moa.*` config section; a failing proposer is captured (not fatal) and the run proceeds with the survivors; `--show-proposals`/`--json`. Pure logic in `packages/core/src/moa/moa.ts`, 23 offline tests in `tests/moa.test.ts` | Closed |
| 4 | **Isolated profiles** | `profile` (multiple fully isolated instances) | ✅ **Done** — `mercury profile list\|create\|use\|show\|current\|remove` (multiple fully isolated instances, each its own `MERCURY_HOME` → own config, memory DB, skills, plugins, audit key; built-in `default` → `~/.mercury` so existing setups are unaffected; registry at `~/.config/mercury/profiles.json`; `use` persists the selection AND prints the `export MERCURY_PROFILE=<name>` line for the current shell; `MERCURY_HOME` wins, else `MERCURY_PROFILE` overrides stored active; `--home`/`--desc`/`--use`, gated `remove --force` with extra `--purge`; `--json`) | Closed |
| 5 | **Projects / workspaces** | `project` (named, multi-folder workspaces) | ✅ **Done** — `mercury project list\|create\|use\|show\|current\|remove` (named workspaces each with their own data dir, scoping config + memory via the existing data-dir indirection; registry at `~/.mercury/projects.json`, `MERCURY_PROJECT` env override; `--dir`/`--folder`/`--desc`/`--use`, gated `remove --force` with extra `--purge`; `--json`) | Closed |
| 6 | **Kanban board** | `kanban` (tasks, links, comments) | — | Missing |
| 7 | **Shell hooks** | `hooks` (shell-script lifecycle hooks) | ✅ **Done** — `mercury hooks list\|events\|add\|remove\|run` run a configured shell command at a **real lifecycle event** (the curated HookManager interception points: `run_start`/`run_end`, `before_llm_call`/`after_llm_call`, `before_tool_call`/`after_tool_call`, `message_received`/`message_sent`, `output`, `memory_write`, `attachment_scan`, `error`, or `*` for all). Every hook that shells out is routed through the **existing approvals layer (`m.approvals`) BEFORE the command is spawned** — the same gate used by every other shell-out — unless opted out per-hook with `--no-approval`. The command gets lifecycle context as `MERCURY_*` env vars (event, run/session/user ids, tool, model, status, platform). Hooks persist in the config `hooks:` array (`type: shell`); the runtime fires them automatically, and `hooks run <name>` fires one manually (still gated). Pure logic in `packages/core/src/hooks/hooks.ts` (parse/validate, event matching, env + plan building, approval-gated dispatch, result formatting — all testable with injected runner/approver/clock) plus a thin `defaultHookRunner` IO layer; 35 offline tests in `tests/hooks.test.ts` | Closed |
| 8 | **External secret stores** | `secrets` (Bitwarden, 1Password) | ✅ **Done** — `mercury secrets backends\|list\|get\|resolve` (pluggable `SecretBackend` abstraction: always-on `env` backend plus opt-in Bitwarden `bw get password` / 1Password `op read` adapters via an injected command runner; `${SECRET:backend:key}`/`${SECRET:key}` references resolved at connect time for MCP server configs, coexisting with the preset `${ENV_VAR}` substitution; values masked by default, raw only via `get --reveal`; `--json`; `secrets.*` config section) | Closed |
| 9 | **Supply-chain audit** | `security` (OSV.dev scan of venv, plugins, MCP servers) | ✅ **Done** — `mercury security audit` (OSV.dev scan of npm deps, configured MCP servers, installed plugins; `--json`, `--npm`/`--mcp`/`--plugins`, `--lockfile`; CI-usable exit codes) | Closed |
| 10 | **Backup / restore** | `backup`, `import`, `dump`, `checkpoints` | ✅ **Done** — `mercury backup` / `mercury import` (full `~/.mercury` archive to a signed, integrity-checked `.mbak`; `backup inspect`, secret-exclusion default with `--include-secrets`, safe restore with `--force` + auto pre-restore backup; `--json`) | Closed |
| 11 | **Session management** | `sessions` (list/rename/export/prune/delete) | ✅ **Done** — `mercury sessions list\|rename\|export\|delete\|prune` over the existing persisted sessions (readable table + `--json`, `--limit`/`--search`; export to JSON or markdown with `--out`; destructive delete/prune gated behind `--force`/`--yes`; `prune` is a dry run by default with `--older-than`/`--keep`/`--empty`) | Closed |
| 12 | **Plugin lifecycle** | `plugins` install/update/remove/list | ✅ **Done** — `mercury plugins install\|update\|remove` (install from a local path or git URL, with install-manifest tracking; `update <name>` / `--all` via git pull or re-copy; gated `remove --force`; `list`/`--json`) on top of the existing loader + `new plugin` scaffold | Closed |
| 13 | **Skill curator** | `curator` (background skill maintenance: run/pause/pin) | Self-distill + `learn`, no curator loop | Missing maintenance loop |
| 14 | **Memory graph & timeline** | `memory-graph`, `journey` timeline, external `memory` provider | ✅ **Done** — `mercury memory-graph` (read-only graph over the stored memory layers: nodes for facts / distilled skills / runs / sessions / knowledge sources; edges grounded in real columns only — `skill→run` from `distilled_skills.source_runs`, `run→session` from `runs.session_id`, `run→run` from `parent_run_id`, `fact→run\|session` from `facts.source` when it equals a known id; readable summary + `--json` nodes/edges + Graphviz `--dot` export; `--since`/`--until`/`--limit`/`--top`) and `mercury journey` (newest-first timeline over existing events: memory formation, skill distillation, knowledge ingestion, runs, learn/reflection outcomes, session starts; `--since`/`--until`/`--limit`/`--kind`, `--json`). Pure, offline-tested; the **external `memory` provider** is NOT implemented. | Partial — graph + timeline done; external memory provider pending |
| 15 | **Usage insights** | `insights` (analytics) | ✅ **Done** — `mercury insights` (read-only analytics over the recorded `usage` token/cost ledger joined to `runs`: totals + breakdowns `--by day\|model\|agent\|session`, `--since`/`--until` range, `--top <n>`, `--limit`; readable token/cost formatting; `--json`; clean "no usage recorded" on an empty ledger) | Closed |
| 16 | **Agent Client Protocol** | `acp` (ACP server) | ✅ **Done** — `mercury acp serve` (ACP server over stdio, newline-delimited JSON-RPC 2.0) exposing the SAME agent + tool surface as the MCP server to external clients (editors/IDEs). Implements `initialize` (version/capability negotiation, no auth advertised), `session/new`, `session/list`, `session/prompt` (streams `session/update` agent-message + tool-call notifications, answers a `stopReason`), the `session/cancel` notification, and vendor extensions `_mercury/tools/list` / `_mercury/tools/call`; `session/load` + `auth/*` are deliberately unsupported (loadSession=false). Pure dispatch/parse layer in `packages/core/src/acp/acp.ts` (unit-testable with injected agent stub + notification sink) + thin stdio transport; runtime adapter `m.acpAgent(principal)` binds a principal via closure; `mercury acp info\|methods` print the protocol surface (`--json`) | Closed |
| 17 | **Language Server Protocol** | `lsp` (LSP server) | ✅ **Done** — `mercury lsp serve` (LSP server over stdio, JSON-RPC 2.0 with **Content-Length header framing**) exposing the SAME agent + tool surface as the MCP/ACP servers to LSP-capable editors/IDEs (VS Code, Neovim, Zed). Implements the lifecycle `initialize` (capability negotiation → `serverInfo` + `capabilities`), the `initialized` ack, `shutdown` + the `exit` notification; full document sync via `textDocument/didOpen`/`didChange`/`didClose`; `workspace/executeCommand` for `mercury.prompt` / `mercury.tools.list` / `mercury.tools.call`; and vendor extensions `_mercury/agent/prompt` / `_mercury/tools/list` / `_mercury/tools/call`. Agent output streams back as `$/progress` notifications. Pure framing (`encodeLspMessage`/`decodeLspFrames` — partial buffers + multiple messages per chunk) and dispatch/parse layer in `packages/core/src/lsp/lsp.ts` (unit-testable with injected agent stub + notification sink) + thin stdio transport; runtime adapter `m.lspAgent(principal)` binds a principal via closure; `mercury lsp info\|methods` print the protocol surface (`--json`). Pulled forward from the Tier-4 batch. | Closed |
| 18 | **OAuth→OpenAI proxy** | `proxy` (local OpenAI-compatible proxy to OAuth providers) | — | Missing |
| 19 | **Pooled provider auth / fallback** | `auth` (pooled credentials), `fallback` providers | ✅ **Done (fallback + criteria routing)** — two new, opt-in, backward-compatible `llm.*` features modelled on the proven Hermes design (ordered `fallback_providers` + a centralized `error_classifier`), translated into TypeScript (nothing imported from Hermes). **(1) Automatic provider/model fallback chain** (`llm.fallback`: an ordered list of `{provider, model, baseUrl?}` pairs; `mercury fallback list\|add\|remove\|clear`): when the primary (provider, model) is **unavailable**, `LLMService.chat()` advances to the next entry in order until one succeeds or the chain is exhausted. The "treat-as-unavailable → fall back" decision is centralized in ONE classifier (`isFallbackError`, `packages/core/src/llm/fallback.ts`) — it falls back on model-not-found/unknown-provider/misconfig, bad/missing API key (401/403), model-not-found (404), rate-limit/overload (429/503/529/5xx), connection-refused/network errors, and an open circuit breaker; it deliberately does **not** fall back on context-overflow, content-policy, or bad-request/format (400/422), which propagate because they would recur on any model. **(2) Criteria-based model selection** (`llm.routing`: a list of `{provider, model, criteria: string[]}`; `mercury route list\|add\|remove\|clear`): before each task/chat/workflow call, `selectModelByCriteria` matches the request's tags (explicit + inferred, reusing the existing profile tag vocabulary general/code/reasoning/fast/cheap/vision/local/private) against each entry's criteria (AND semantics; most-specific wins; empty-or-`['default']` = general-purpose catch-all) and hands the chosen model to the router as the explicit model, so it still gets RBAC + the fallback chain. Pure, offline-tested logic in `packages/core/src/llm/fallback.ts` + thin wiring in `llm/service.ts`; **21 tests** in `tests/model-selection.test.ts` (classifier taxonomy, chain build/dedup, criteria matching incl. the catch-all, and end-to-end: chain advances on an unavailable-class error, aborts after exhaustion, non-fallback errors propagate, criteria picks the expected model). **Honesty note:** failover is exercised with the offline MockProvider via injected faults — real third-party provider outages were not exercised, and the `baseUrl` field is persisted for forward-compat but a per-entry base-URL override is not yet wired into provider construction (the referenced provider must be configured for the id to resolve). The **pooled-credential manager** (`auth`) is still NOT implemented. | Partial — automatic fallback + criteria routing done; pooled-credential manager pending |
| 20 | **Operator conveniences** | `completion`, `logs`, `prompt-size`, `migrate`, `console`, `pairing` | ✅ **Done** — `completion <bash\|zsh\|fish>` prints a shell-completion script generated from the real command/subcommand list; `logs` views recent activity (readable table + `--json`, `--limit`, `--since`/`--until`) read-only from the existing `runs` table (no new log store); `prompt-size` reports per-component char + approx-token sizes of the assembled system prompt (persona, instruction hierarchy, skills/tools index; honest `~4 chars/token` offline approximation, live-only memory shown as 0; `--json`); `migrate status`/`migrate up` report applied-vs-pending and apply pending migrations by **reusing the existing runner + append-only `MIGRATIONS`** (no new migrations; `--json`); `console` launches the existing REPL with an operator banner (version, user, data dir, db path, config summary). `pairing` was already covered by `gateway pair`, so it was left untouched. | ✅ Closed — pure logic in `packages/core/src/operator/operator.ts`, CLI in `commands.ts`/`bin.ts`; covered by `tests/operator.test.ts`; EN+DE help added (`docs/help/{completion,logs,prompt-size,migrate,console}.md`). |

---

## 2. Already at parity (NOT gaps)

Mercury matches these Hermes capabilities today: interactive `chat` + headless `serve`; chat-platform
gateways (Mercury ships 19 adapters); **task scheduling** (`schedule`, cron-style — Hermes `cron`);
multi-agent **workflows** and **teams**; **persistent memory** (working/episodic/semantic/procedural);
**skills** in agentskills.io format; **bundles**; **MCP client and server** (+ 14 optional integration
presets as of v1.8.0); **voice** STT/TTS; **auth / tokens / RBAC / audit log**; `doctor`; `update`.

**Mercury-only extras** (beyond the Hermes surface): the **Jev decision engine**, the `eval`
self-evaluation harness, the reliability/efficiency toolkit (circuit breaker, saga, TTL cache,
single-flight), the **LLM Wiki**, declarative **add-ins**, per-agent **permission profiles**,
**proactive** event triggers, and run **replay**. It also ships `import-agent` to migrate from Hermes.

---

## 2a. Internationalization (new in v2.1.0 — English + German)

Mercury now ships a **complete bilingual (EN/DE) surface**, built on the i18n convention that already
existed in the repo rather than a competing mechanism:

- **Message catalog.** `locales/en.json` and `locales/de.json` are at **full key parity — 475 keys
  each**, every German value non-empty (verified by test). This pass filled the previously-missing
  German `governance.*` (24 keys) and the `models` economics group (10 keys), and added a new `cli.*`
  namespace (`cli.fallback.*`, `cli.route.*`, `cli.hooks.*`) in BOTH languages for the recently added
  commands. Catalogs are consumed through the existing `I18n` class
  (`packages/core/src/i18n/i18n.ts`): dotted-key lookup, `{var}` interpolation, locale→en→key fallback.
- **Locale resolver.** New `resolveLocale({configLocale, env})` in `i18n.ts` with a documented
  precedence `MERCURY_LANG > MERCURY_LOCALE > config.locale > 'en'`; region tags are stripped and cased
  (`de_DE`/`de-AT`/`DE` → `de`) and any unsupported locale falls back to English. `MERCURY_LANG` was
  also wired into the config env-override map (`packages/core/src/config/load.ts`) as an alias of the
  locale setting. `SUPPORTED_LOCALES = ['en','de']` is exported.
- **CLI user-facing strings.** The newly added `fallbackCmd`, `routeCmd` and `hooksCmd` user-facing
  outputs (22 strings) are now routed through `m.i18n.t('cli.…')` so they localize. Other pre-existing
  hardcoded command strings (plugin/project/profile/session) were left untouched this pass — a known,
  disclosed remainder, not full command-surface coverage.
- **Help topics.** Every English help topic under `docs/help/` has a German counterpart under
  `docs/help/de/` — **42 topics in each language, verified at parity by test** (added `fallback.md` and
  `route.md` in both languages this pass; `hooks.md` already existed in both).
- **Manuals.** `docs/SETUP_GUIDE.md`, `docs/GUIDE.md`, `docs/HANDBOOK.md`, `docs/WIKI.md`, `README.md`,
  `CHANGELOG.md` and `STATUS.md` were updated for the fallback/route/hooks commands and the version bump
  to **2.1.0**.
- **Tests.** `tests/i18n.test.ts` (17 tests) covers the resolver precedence/normalization/fallback,
  catalog resolution + interpolation in both languages, EN↔DE catalog key parity (no orphan or empty
  keys), and EN↔DE help-topic file parity. `tests/help.test.ts` continues to cover runtime help
  localization.
- **Honesty note.** The i18n layer is exercised entirely offline (catalog + resolver + file parity);
  full command-surface string coverage is intentionally partial (new features + prominent commands
  first), and no live translation-quality review beyond consistency with the existing German help files
  was performed.

---

## 2b. Self-extending tools / dynamic tool synthesis (new — Mercury-only extra)

A capability **neither Hermes nor the earlier Mercury had**: Mercury can **draft a brand-new tool**
when a capability is repeatedly needed but no registered tool provides it. This is deliberately a
**Mercury-only extra** and a high-risk one, so it is **DISABLED BY DEFAULT** behind the master
`selfExtension.enabled = false` kill-switch.

**Pipeline (every step gated):** threshold-based **gap detection** (a `tool.miss` runtime event; a gap
is actionable only after `missThreshold` misses of the same capability, default 3) → **authoring** by
an injected LLM runner (tool name + schema + implementation + a **generated unit test** + a
least-privilege **capability manifest**) → **validation before registration** (manifest policy
deny-by-default → compile check → the generated unit test, all out-of-process, never `eval`) →
**approval gating** (PENDING until a human approves, unless `autoApprove` is explicitly set) →
**sandboxed out-of-process execution** as a persisted polyglot tool folder (scrubbed env, no network
unless declared, time/output caps) → **provenance + audit** → **persistence** across sessions.

**Surfaces.** `mercury selfextend status|enable|disable|list|gaps|synthesize|approve|deny` (all
`--json`); Web UI **Self-Extend** admin panel; API `GET /api/selfextend`,
`POST /api/selfextend/toggle`, `POST /api/selfextend/:id/approve|deny`. Config section
`selfExtension.*`. EN+DE help (`docs/help/selfextend.md`, `docs/help/de/selfextend.md`) and full EN/DE
i18n for every user-facing string.

**Safety / threat model.** Mitigations, each mapped to a threat:

| Threat | Mitigation |
|--------|-----------|
| Feature abused / unexpected code generation | **Disabled by default**; master `enabled:false` kill-switch; hard localized no-op on every surface when off |
| Over-privileged generated tool | **Deny-by-default capability manifest** — every requested capability (fs/network/host/shell) must be explicitly granted in config; over-privileged drafts are **refused**, never auto-widened |
| Secret exfiltration by generated code | **No ambient secrets** — execution env is scrubbed (reuses `safeEnv()`); network unavailable unless the manifest declared it and the host is allow-listed |
| Malicious/broken tool runs unchecked | **Validation + generated-test gate before registration** (compile + unit test, out-of-process) and **mandatory approval before first run** |
| Code injected into the main process | **Out-of-process execution** behind the existing polyglot sandbox boundary — never `eval`'d in the runtime |
| Runaway resource use | **Time, output, and runtime limits** (`timeoutMs`, `maxOutputChars`, allowed `runtimes`), process-group kill on timeout |
| No accountability | **Full audit trail + provenance** (`.synth.json` per tool: capability, prompt digest, manifest, validation result, approver) |

**Status — honest.** The **infrastructure is implemented and offline-tested**: gap detection +
threshold, authoring contract + draft parsing, validation gate (accept + reject on
manifest/compile/test), approval gating (pending/approve/deny/auto-approve), policy enforcement
(deny-by-default, host allow-list), provenance/audit, persistence/reload, disabled no-op, and
config/CLI parsing — plus a **real local compile/test runner** exercised against good and bad Python
drafts. **Not verified in CI:** the quality of drafts produced by a real production LLM, and execution
inside the full polyglot/Docker host sandbox (CI exercises the lighter host child-process compile/test
path). Treat real-LLM authoring and production-sandbox execution as **experimental**.

---

## 2c. Hands-free voice mode in the web chat UI (new — ChatLLM-style)

**What was added.** The web chat UI (`packages/server/public`) gained a **ChatLLM-style hands-free
voice experience** on top of the pre-existing server-side voice (the manual per-message 🔊 play button
and the MediaRecorder → `/api/voice/transcribe` mic). Two behaviours were the gap and are now closed:

- **Automatic read-aloud toggle** — a 🔊/🔇 button in the chat header (persisted in `localStorage`
  under `mercury.voice.autospeak`, **OFF by default**). When ON, every completed assistant reply is
  spoken automatically; toggling it off cancels any in-progress speech.
- **Hands-free mic with optional auto-send** — the 🎤 mic now prefers the browser's native
  speech-to-text, shows a clear "listening…" state, and (when the 🗣/🖐 auto-send toggle is ON,
  persisted under `mercury.voice.autosend`, **OFF by default**) sends the spoken command automatically.

**Progressive enhancement (the design point).** Browser-native Web Speech APIs are the **primary**
path and need no server models: `window.speechSynthesis` for read-aloud and
`SpeechRecognition`/`webkitSpeechRecognition` for the mic, with the UI language mapped to a speech
language (`de-*` → `de-DE`, else `en-US`). The existing server endpoints `/api/voice/speak` (piper)
and `/api/voice/transcribe` (whisper) remain the **graceful fallback** when the browser APIs are
absent. Nothing hard-fails: if neither path is available the controls degrade quietly and text chat is
unaffected.

**Code / tests.** New testable module `packages/server/public/js/voice.js` exports pure/injectable
helpers (`speakableText` markdown→speech stripper, `resolveSpeechLang`, `pickVoice`, capability
detection, `chooseSpeakPath`/`chooseListenPath` fallback selection, and `createSpeaker` /
`createRecognitionListener` wrappers). `chat.js` consumes them. **23 offline unit tests** in
`tests/voice-web.test.ts` drive every helper and both wrappers with **fake browser globals** (no real
microphone, speaker or DOM). EN/DE i18n parity is maintained (new `chat.readAloud*`, `chat.listening`,
`chat.autoSend*` keys in both catalogs).

**Caveats / untested surface (honest).**

- **Browser support for the Web Speech API varies.** Chrome/Edge support `SpeechRecognition`;
  **Firefox and (older) Safari do not**, and `speechSynthesis` voice availability differs per
  platform. Hence the server fallback — but note the fallback depends on the piper/whisper binaries,
  which live on the VM system disk and are **not present in every deployment**.
- **The DOM wiring in `chat.js`** (button rendering, event handlers, `localStorage` persistence, the
  `type === 'done'` auto-speak hook) is **not unit-tested** — only the extracted helpers are. It was
  verified manually against a locally-served dev instance (page loads, controls render).
- Browser-native STT requires an **HTTPS origin** (or `localhost`) and a user gesture to grant mic
  permission — unchanged from the previous MediaRecorder behaviour.

---

## 3. Vendor-specific (out of scope — match only if you choose to)

`portal` (Nous Portal login/model/tool-gateway), `claw` (OpenClaw migration), `pets` / petdex
(cosmetic animated pets), `whatsapp-cloud` (WhatsApp Business Cloud specifics). These are tied to
Nous Research's ecosystem or are cosmetic; they are not parity obligations.

---

## 4. Prioritized roadmap to close the gaps

Ordered by value-to-effort for a self-hosted agentic platform. Each tier is independent.

### Tier 1 — High value, moderate effort (do first)

1. ✅ **Done — Supply-chain audit (`mercury security audit`)** — wraps OSV.dev over `package-lock.json`,
   installed plugins and configured MCP servers. Human table grouped by source plus `--json`; narrowing
   flags `--npm`/`--mcp`/`--plugins` and a `--lockfile <path>` override; CI-usable exit codes (0 clean,
   1 vulnerabilities found, 2 could-not-complete). Engine in `packages/core/src/security/supply-chain.ts`
   with an injectable HTTP client; offline deterministic tests in `tests/security-audit.test.ts`.
2. ✅ **Done — Backup / restore (`mercury backup` / `mercury import`)** — snapshots the full Mercury home
   (`~/.mercury`: config, memory DB + `-wal`/`-shm`, skills, add-ins, permissions, plugins, wiki, bundles)
   into a single gzipped-JSON `.mbak` archive. Each archive carries a per-file SHA-256, a content digest
   and an optional HMAC signature using the instance audit key; the format is deterministic and adds zero
   new dependencies. Secrets (`.env`, `audit.key`) are excluded by default (`--include-secrets` opts in);
   volatile files (`*.log`, `*.mbak`, sockets, pids, temp, `node_modules/`, `.git/`) are always excluded.
   CLI: `mercury backup` (create), `mercury backup inspect <file>` (verify digest/hashes/signature/compat
   without restoring) and `mercury import <file>` / `restore` (refuses to overwrite without `--force`;
   `--force` first writes a reversible pre-restore safety backup; integrity is verified before any write).
   Engine in `packages/core/src/backup/backup.ts` (pure + thin fs layer); offline deterministic tests in
   `tests/backup.test.ts`.
3. ✅ **Done — Session management CLI (`mercury sessions list|rename|export|delete|prune`)** — a
   read/manage surface over the sessions Mercury already persists in the SQLite memory DB; it does not
   change the write path or schema. `list` prints a most-recent-first table (short id, updated time,
   message count, title, model/cwd) with `--limit`, `--search` and `--json`; `rename <id> <title>` sets a
   session title (id may be a unique prefix); `export <id>` emits the session + messages as JSON (default)
   or a markdown transcript (`--format md`) to stdout or `--out <path>`; `delete <id>` is gated behind
   `--force`/`--yes`; `prune` is a DRY RUN by default (`--older-than <dur|ISO>`, `--keep <n>`, `--empty`,
   union semantics with keep-N protecting the most-recent N) and only deletes with `--force`/`--yes`.
   Pure selection/filtering/export logic in `packages/core/src/sessions/manage.ts` (fully unit-testable
   with injected data + clock) over a read-only `EpisodicStore.listAll()`; offline deterministic tests in
   `tests/sessions.test.ts`.
4. ✅ **Done — Full plugin lifecycle (`mercury plugins install|update|remove`)** — Mercury already
   *loads* and discovers plugins (`packages/core/src/plugins/plugin.ts`) and scaffolds them
   (`mercury new plugin`); this closes the loop with install / update / remove from a **local path** or a
   **git URL**, extending the previously list-only `plugins` command. `install <path|git-url>` resolves
   the source (git vs path), derives a safe install name (or `--name`), validates a local source *before*
   touching the destination, copies a directory / single `.js` file or `git clone`s the repo into
   `~/.mercury/plugins/<name>/`, writes a `.mercury-plugin.json` install manifest (source, version,
   timestamps), and optionally `--build`s when the plugin declares a build script; `--force` overwrites.
   `update <name>` (or `--all`) refreshes from the recorded source — `git pull --ff-only` for git,
   re-copy for a path — and `remove <name>` is gated behind `--force`/`--yes`. `list` keeps the loaded
   view and adds `--json` over the on-disk installs. Pure/testable logic plus a thin fs layer with an
   **injected command runner + clock** (so tests never shell out or hit the network) in
   `packages/core/src/plugins/manage.ts`; offline deterministic tests in `tests/plugins-manage.test.ts`;
   EN/DE help in `docs/help/plugins.md` / `docs/help/de/plugins.md`.

### Tier 2 — High value, higher effort

5. ✅ **Done — Projects / workspaces (`mercury project list|create|use|show|current|remove`)** — named
   workspaces, each with its **own data dir**, so different projects never share state. Because Mercury
   already keys its memory DB, config, plugins, skills and audit key off the resolved data dir, pointing
   that dir at a per-project folder scopes **config and memory together** — this layers project selection
   onto the existing `MERCURY_HOME` / `MERCURY_DATA_DIR` indirection rather than inventing a parallel
   mechanism. Projects live in a registry at `~/.mercury/projects.json` (the Mercury home, above the
   per-project dirs); each defaults its data dir to `~/.mercury/projects/<name>/` or takes an explicit
   `--dir`. `loadConfig` resolves the active project's data dir on the next run (an explicit
   `MERCURY_DATA_DIR`, or a `MERCURY_PROJECT` env var naming a registered project, overrides it; isolated
   loads are unaffected). CLI: `create <name>` (`--dir`, `--folder <p1,p2>`, `--desc`, `--use`),
   `use <name>` (switch active), `list` (table + `--json`, active marker + data-dir-exists), `show [name]`
   (details incl. data-dir entry count; defaults to active), `current` (active name or `(none)`), and a
   gated `remove <name>` (`--force`/`--yes`; keeps the data dir by default, extra `--purge` deletes it);
   `--json` everywhere. Pure registry logic (validation, parse/serialize, CRUD, active-project resolution)
   plus a thin fs layer with an **injected clock** in `packages/core/src/projects/manage.ts`; offline
   deterministic tests in `tests/projects.test.ts`; EN/DE help in `docs/help/project.md` /
   `docs/help/de/project.md`.
6. ✅ **Done — External secret stores (`mercury secrets backends|list|get|resolve`)** — pluggable secret
   backends resolving `${SECRET:...}` references at connect time, so plaintext secrets never live in the
   config file. A `SecretBackend` abstraction maps a key to a value: an always-on `env` backend (reads
   from an env map / `process.env`) plus opt-in adapters for the Bitwarden CLI (`bw get password <key>`)
   and 1Password CLI (`op read <op://...>`), each invoked through an **injected command runner** so the
   design is extensible and tests never shell out. The resolver expands `${SECRET:backend:key}` and
   `${SECRET:key}` (default/configured backend) references; it only ever touches `${SECRET:...}` and
   leaves the MCP preset `${ENV_VAR}` substitution untouched, so the two coexist. Resolution is wired
   into the real connect path (`packages/runtime/src/mercury.ts` expands `config.mcp.servers` before
   `mcp.connectAll`, logging only the *count* of unresolved refs — never keys or values) and exposed as a
   library (`secretResolverFromConfig`, `expandSecretsDeep`, `scanSecretRefs`). CLI: `backends` (configured
   backends + availability), `list` (refs in the live config with resolve status), `get <ref>` (resolve a
   single reference — **masked unless `--reveal`**), `resolve [--config <path>]` (scan a config and report
   masked); `--json` everywhere; non-zero exit on unresolved refs. Secret values are never persisted or
   logged and are masked by default (`maskSecret` is fixed-width, no length leak). A `secrets.*` config
   section (`defaultBackend`, `bitwarden.{enabled,command}`, `onepassword.{enabled,command}`) selects
   backends. Pure logic + thin default runner in `packages/core/src/secrets/secrets.ts`; offline
   deterministic tests with an injected runner in `tests/secrets.test.ts`; EN/DE help in
   `docs/help/secrets.md` / `docs/help/de/secrets.md`.
7. ✅ **Done — Isolated profiles (`mercury profile list|create|use|show|current|remove`)** — multiple
   **fully isolated** instances, each its own **home directory** (`MERCURY_HOME`) and therefore its own
   config, memory DB, skills, plugins, personalities and audit key. This is the home-level sibling of a
   project (#5): where a project selects the **data dir** *within* a home, a profile selects an entirely
   separate **home** — the layering is *profile → selects `MERCURY_HOME`*, then *project → selects the data
   dir within it*. It is "orchestration over the existing home-dir indirection": `mercuryHome()` in
   `packages/core/src/config/load.ts` already drives the home off `MERCURY_HOME`, so this just records which
   profile is active and resolves its home on the next run (an explicit `MERCURY_HOME` always wins — the
   resolver returns `undefined` so the env value is used — otherwise a `MERCURY_PROFILE` env var overrides
   the stored active profile; isolated loads, which set their own data dir, are unaffected). Because
   profiles sit **above** homes, their registry lives at `~/.config/mercury/profiles.json` (override the
   directory with `MERCURY_PROFILES_DIR`), not inside any one home; non-default homes default to
   `~/.mercury-profiles/<name>/` (override the base with `MERCURY_PROFILES_HOME`, or set `--home` per
   profile). A built-in **`default`** profile always exists and maps to the standard `~/.mercury`, so
   existing setups are completely unaffected; it cannot be created, removed or purged. Because a process
   cannot mutate its parent shell's environment, `use <name>` BOTH persists the selection (new processes
   pick it up) AND prints the exact `export MERCURY_PROFILE=<name>` line for the current shell (like
   pyenv/direnv). CLI: `create <name>` (`--home`, `--desc`, `--use`), `use <name>` (switch active + print
   export line), `list` (table + `--json`, default first, active marker + home-exists), `show [name]`
   (details incl. home entry count; defaults to active/default), `current` (active name or `default`), and a
   gated `remove <name>` (`--force`/`--yes`; keeps the home dir by default, extra `--purge` deletes it but
   never `~/.mercury`); `--json` everywhere. Pure registry logic (validation, parse/serialize, CRUD,
   active-profile resolution, home-path resolution) plus a thin fs layer with an **injected clock/env** in
   `packages/core/src/profiles/manage.ts`; offline deterministic tests in `tests/profiles.test.ts`; EN/DE
   help in `docs/help/profile.md` / `docs/help/de/profile.md`.
8. ✅ **Done — Usage insights (`mercury insights`)** — a read-only analytics view over the token/cost
   data Mercury **already records**: the `usage` ledger (written on every model call by
   `BudgetService.record`) joined to the `runs` table for session attribution. No new instrumentation or
   schema. Computes totals (calls, input/output/total tokens, cost) and breakdowns `--by
   day|model|agent|session`, with `--since`/`--until` time-range filtering (duration or ISO), `--top <n>`
   for the costliest buckets, and `--limit <n>` on rows read. Readable token (`1,234`/`15.0k`/`2.4M`) and
   cost formatting; `--json` emits the full report; an empty ledger prints `no usage recorded` and exits
   `0` (non-zero only on real errors). Pure aggregation + formatting in `packages/core/src/insights/
   insights.ts` (fully unit-testable over injected rows + injected clock) with a thin read-only DB query
   layer; CLI `insightsCmd` in `packages/cli/src/commands.ts`; offline deterministic tests in
   `tests/insights.test.ts`; EN/DE help in `docs/help/insights.md` / `docs/help/de/insights.md`.

**Tier 2 is now complete — all of #5–#8 are done.**

### Tier 3 — Strategic / ecosystem

9. ✅ **Done — ACP server (`mercury acp`)** — expose Mercury over the Agent Client Protocol so external
   clients (editors, IDEs such as Zed) can drive it; complements the existing MCP server. `mercury acp
   serve` runs a JSON-RPC 2.0 server over stdio (newline-delimited, one message per line) exposing the
   SAME underlying agent + tool surface the MCP server exposes. Implemented method surface: `initialize`
   (negotiates the integer protocol version and advertises capabilities — `loadSession=false`, empty
   `authMethods`, `sessionCapabilities.list`), `session/new` (opens a session → `sessionId`),
   `session/list`, `session/prompt` (runs one turn; streams `session/update` notifications —
   `agent_message_chunk` plus any `tool_call`/`tool_call_update` the agent pushes — then answers with a
   `stopReason`), the `session/cancel` notification, and two vendor extensions `_mercury/tools/list` /
   `_mercury/tools/call` (ACP reserves the `_` prefix) that reach Mercury's full tool surface.
   `session/load` and `auth/*` are deliberately unsupported. Core logic lives in
   `packages/core/src/acp/acp.ts`, split into pure request parsing/dispatch functions (unit-testable
   with an injected `AcpAgent` stub + injected notification sink) and a thin stdio transport
   (`serveAcpStdio`). The runtime adapter `m.acpAgent(principal)` binds a principal via closure (exactly
   as `serveStdio` does for MCP) and returns the agent's final output as a single `agent_message_chunk`.
   CLI: `mercury acp serve` (stdio loop wired in `bin.ts`), `mercury acp info|methods` (`--json`) print
   the protocol surface. Offline deterministic tests in `tests/acp.test.ts` (34 tests) cover parsing,
   every handler, error paths and stdio framing; EN/DE help in `docs/help/acp.md` /
   `docs/help/de/acp.md`. **Honesty:** every handler, the JSON-RPC framing and the error paths are
   exercised offline against stubs; it has **not** been exercised against a real external ACP client
   (e.g. Zed).
10. ✅ **Done — Mixture-of-Agents (`mercury moa`)** — `mercury moa "<prompt>"` sends the SAME prompt to
    several **proposer** model slots in parallel, collects their proposals, and produces one final
    answer by one of two strategies: `synthesize` (hand every proposal to an **aggregator** model slot
    that writes the final answer) or `vote` (majority / self-consistency — the answer backed by the most
    proposers wins, ties broken by first appearance; no aggregator call). This is a natural extension of
    the Jev router and teams: a "model slot" is the same `"<provider>/<model>"` id (or `"auto"`) the
    router/registry already resolve, and every proposer/aggregator call flows through the SAME
    `LLMService.complete` gateway (routing, RBAC, budgets, retries, usage ledger) via an injected runner
    — MoA layers aggregation on top rather than inventing a second LLM path. Core logic lives in
    `packages/core/src/moa/moa.ts`, split into PURE functions (prompt building, `tallyVotes`, validation,
    `runProposers` fan-out, `runMoa` orchestration — all unit-testable with an injected `MoaModelCall`
    stub) plus the injected runner; the runtime adapter is `m.moaModelCall(principal)`. A proposer that
    errors is captured (status `error`) and the run proceeds with whatever succeeded (graceful
    degradation, mirroring teams); if EVERY proposer fails the command errors. Proposer/aggregator slots
    and strategy are configurable via flags (`--proposers a,b`, `--aggregator x`, `--strategy
    synthesize|vote`, `--system`, `--show-proposals`, `--json`) or the new `moa.*` config section (empty
    `proposers` → default model). CLI `moaCmd` wired in `bin.ts`; offline deterministic tests in
    `tests/moa.test.ts` (23 tests) cover fan-out, both aggregation strategies, voting, validation and the
    all-failed/empty edge cases; EN/DE help in `docs/help/moa.md` / `docs/help/de/moa.md`. **Honesty:**
    the fan-out, synthesize/vote aggregation, validation and graceful-degradation paths are exercised
    offline against an injected model-call stub; the engine has **not** been run against real models here
    (the live runner is wired to the LLM gateway and needs provider credentials).
11. ✅ **Done — Memory graph & journey timeline (`mercury memory-graph`, `mercury journey`)** — two
    **read-only** views over data Mercury already records; they add NO instrumentation and NO schema.
    `mercury memory-graph` builds a graph whose **nodes** are the existing memory entities (facts /
    distilled skills / runs / sessions / knowledge sources) and whose **edges are grounded in real
    stored columns only** — none are invented, and an edge is emitted only when BOTH endpoints exist in
    the view: `skill --distilled_from--> run` (`distilled_skills.source_runs`), `run --in_session-->
    session` (`runs.session_id`), `run --spawned--> run` (`runs.parent_run_id`, parent → child), and
    `fact --sourced_from--> run|session` (`facts.source`, only when it exactly equals a known id).
    Output is a readable summary (node/edge counts by kind, most-connected nodes), a machine-readable
    `--json` (`{ nodes, edges, summary }`), and a standard Graphviz `--dot` export; `--since`/`--until`/
    `--limit`/`--top` scope it. `mercury journey` is a newest-first timeline over existing events
    (memory formation, skill distillation, knowledge ingestion, runs, learn/reflection outcomes, session
    starts) with `--since`/`--until`/`--limit`/`--kind` and `--json`. Reflection/`learn` records feed the
    timeline but NOT graph edges (their `skill` column is a free-text name, not a stored id, so an edge
    would be guesswork). Core logic lives in `packages/core/src/memgraph/memgraph.ts`, split into PURE
    functions (`buildMemGraph`, `memGraphToDot`, `journeyEventsFrom`, `buildJourneyTimeline` — all
    unit-testable with injected rows + an injected clock) plus a thin read-only DB layer
    (`queryMemGraphInput` / `queryJourneyEvents`); CLI `memoryGraphCmd` / `journeyCmd` wired in `bin.ts`;
    offline deterministic tests in `tests/memgraph.test.ts` (19 tests) cover node/edge construction,
    grounded-edge dropping, DOT export, timeline ordering + range/kind/limit filtering, and the empty
    cases; EN/DE help in `docs/help/memory-graph.md` + `docs/help/journey.md` (and `docs/help/de/…`).
    **NOT implemented:** the external pluggable `memory` provider (a `MemoryProvider` abstraction already
    exists in the memory layer, but no concrete external backend was added as part of this gap).
12. ✅ **Done — Shell hooks (`mercury hooks`)** — run a configured **shell command at a real lifecycle
    event**. Hooks bind to the curated HookManager interception points that already fire in the runtime
    (`run_start`/`run_end`, `before_llm_call`/`after_llm_call`, `before_tool_call`/`after_tool_call`,
    `message_received`/`message_sent`, `output`, `memory_write`, `attachment_scan`, `error`) or to `*`
    for every event — no new events were invented; each bound event has a real trigger. **Every hook that
    shells out is routed through the existing approvals layer (`m.approvals`) BEFORE the command is
    spawned**, consistent with every other shell-out in the codebase; `--no-approval` opts a single
    trusted hook out of the gate. The command runs via `sh -c` with the lifecycle context injected as
    `MERCURY_*` environment variables (`MERCURY_HOOK_EVENT`/`MERCURY_HOOK_TS` always, plus
    run/session/user ids, tool, model, status, platform when the firing event carries them). Hooks are
    declared in the config `hooks:` array (`type: shell`, with `name`/`event`/`command`/`enabled`/
    `requiresApproval`); the runtime wires them into the live `HookManager` at startup
    (`installShellHooks`) so they fire in practice, and `mercury hooks run <name>` fires one manually for
    testing (still approval-gated). CLI: `hooks list` (readable table + `--json`), `hooks events` (list
    supported lifecycle names), `hooks add <name> --event --command [--no-approval] [--disabled]`,
    `hooks remove <name> --force`, `hooks run <name>`. Core logic lives in
    `packages/core/src/hooks/hooks.ts`, split into PURE functions (`validateHookDef`, `parseHookDefs`,
    `matchHooks`, `buildHookEnv`, `contextFromPayload`, `buildHookPlan`, `buildHookApprovalRequest`,
    `runHookPlan`, `dispatchHooks`, `formatHookResult`/`formatHookList` — all unit-testable with an
    injected command runner, approver and clock) plus a thin `defaultHookRunner` IO layer that actually
    spawns via `node:child_process`. New boolean flags `--no-approval` and `--disabled` registered in
    `args.ts`. Offline deterministic tests in `tests/hooks.test.ts` (35 tests) cover parse/validate,
    event matching, env + plan building, approval gating (approved / denied / bypass-when-not-required),
    the runner being invoked with the correct env, non-zero-exit and throwing-runner handling,
    `installShellHooks` firing against a real `HookManager`, and the formatting + empty cases; EN/DE help
    in `docs/help/hooks.md` + `docs/help/de/hooks.md`. **Honesty:** the pure parse/match/plan/format and
    the approval-gating + dispatch paths are exercised against injected stubs; **real shell execution
    against the host OS (`defaultHookRunner`) is NOT exercised in the tests.**

### Tier 4 — Niche / low priority

13. Native desktop app (`desktop`), Computer-Use backend (`computer-use`), LSP (`lsp`), OAuth proxy
    (`proxy`), Kanban (`kanban`), operator conveniences (`completion`, `logs`, `prompt-size`,
    `migrate`). Useful but either heavy (desktop/computer-use) or low-frequency.

---

## 5. Caveats

- This is a **CLI-surface** comparison: a command's presence does not prove equivalent depth, and its
  absence in one column does not prove the capability is wholly missing (it may exist as a library
  without a dedicated command).
- The Hermes side is the Nous Research Hermes Agent installed on this host at the time of writing; a
  different Hermes version may expose a different command set.
- The Mercury side is this repository at **v2.1.0**. Re-run `hermes --help` and `mercury help` to
  refresh this diff after either side changes.
