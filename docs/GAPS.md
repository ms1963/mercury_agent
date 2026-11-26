![Mercury Agent](../assets/mercury_agent.png)

# Mercury vs Hermes Agent — Capability Gaps

**What this document is.** A grounded, command-level diff between **Hermes Agent** (Nous Research;
the real installation present on this machine) and **Mercury Agent** (this repository at **v1.9.0**).

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
| 7 | **Shell hooks** | `hooks` (shell-script lifecycle hooks) | — | Missing |
| 8 | **External secret stores** | `secrets` (Bitwarden, 1Password) | ✅ **Done** — `mercury secrets backends\|list\|get\|resolve` (pluggable `SecretBackend` abstraction: always-on `env` backend plus opt-in Bitwarden `bw get password` / 1Password `op read` adapters via an injected command runner; `${SECRET:backend:key}`/`${SECRET:key}` references resolved at connect time for MCP server configs, coexisting with the preset `${ENV_VAR}` substitution; values masked by default, raw only via `get --reveal`; `--json`; `secrets.*` config section) | Closed |
| 9 | **Supply-chain audit** | `security` (OSV.dev scan of venv, plugins, MCP servers) | ✅ **Done** — `mercury security audit` (OSV.dev scan of npm deps, configured MCP servers, installed plugins; `--json`, `--npm`/`--mcp`/`--plugins`, `--lockfile`; CI-usable exit codes) | Closed |
| 10 | **Backup / restore** | `backup`, `import`, `dump`, `checkpoints` | ✅ **Done** — `mercury backup` / `mercury import` (full `~/.mercury` archive to a signed, integrity-checked `.mbak`; `backup inspect`, secret-exclusion default with `--include-secrets`, safe restore with `--force` + auto pre-restore backup; `--json`) | Closed |
| 11 | **Session management** | `sessions` (list/rename/export/prune/delete) | ✅ **Done** — `mercury sessions list\|rename\|export\|delete\|prune` over the existing persisted sessions (readable table + `--json`, `--limit`/`--search`; export to JSON or markdown with `--out`; destructive delete/prune gated behind `--force`/`--yes`; `prune` is a dry run by default with `--older-than`/`--keep`/`--empty`) | Closed |
| 12 | **Plugin lifecycle** | `plugins` install/update/remove/list | ✅ **Done** — `mercury plugins install\|update\|remove` (install from a local path or git URL, with install-manifest tracking; `update <name>` / `--all` via git pull or re-copy; gated `remove --force`; `list`/`--json`) on top of the existing loader + `new plugin` scaffold | Closed |
| 13 | **Skill curator** | `curator` (background skill maintenance: run/pause/pin) | Self-distill + `learn`, no curator loop | Missing maintenance loop |
| 14 | **Memory graph & timeline** | `memory-graph`, `journey` timeline, external `memory` provider | Layered memory + `learn` | No graph/timeline/external provider |
| 15 | **Usage insights** | `insights` (analytics) | ✅ **Done** — `mercury insights` (read-only analytics over the recorded `usage` token/cost ledger joined to `runs`: totals + breakdowns `--by day\|model\|agent\|session`, `--since`/`--until` range, `--top <n>`, `--limit`; readable token/cost formatting; `--json`; clean "no usage recorded" on an empty ledger) | Closed |
| 16 | **Agent Client Protocol** | `acp` (ACP server) | ✅ **Done** — `mercury acp serve` (ACP server over stdio, newline-delimited JSON-RPC 2.0) exposing the SAME agent + tool surface as the MCP server to external clients (editors/IDEs). Implements `initialize` (version/capability negotiation, no auth advertised), `session/new`, `session/list`, `session/prompt` (streams `session/update` agent-message + tool-call notifications, answers a `stopReason`), the `session/cancel` notification, and vendor extensions `_mercury/tools/list` / `_mercury/tools/call`; `session/load` + `auth/*` are deliberately unsupported (loadSession=false). Pure dispatch/parse layer in `packages/core/src/acp/acp.ts` (unit-testable with injected agent stub + notification sink) + thin stdio transport; runtime adapter `m.acpAgent(principal)` binds a principal via closure; `mercury acp info\|methods` print the protocol surface (`--json`) | Closed |
| 17 | **Language Server Protocol** | `lsp` | — | Missing |
| 18 | **OAuth→OpenAI proxy** | `proxy` (local OpenAI-compatible proxy to OAuth providers) | — | Missing |
| 19 | **Pooled provider auth / fallback** | `auth` (pooled credentials), `fallback` providers | Fallback chain exists; no pooled-credential manager | Partial |
| 20 | **Operator conveniences** | `completion`, `logs`, `prompt-size`, `migrate`, `console`, `pairing` | `gateway pair` exists; others absent | Several small gaps |

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
11. **Memory graph & journey timeline** — a graph view and chronological timeline over the existing
    memory/skill-distillation events.
12. **Shell hooks (`mercury hooks`)** — lifecycle shell-script hooks with approval gating (reuse the
    existing approvals/guardrails layer).

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
- The Mercury side is this repository at **v1.9.0**. Re-run `hermes --help` and `mercury help` to
  refresh this diff after either side changes.
