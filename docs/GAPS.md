![Mercury Agent](../assets/mercury_agent.png)

# Mercury vs Hermes Agent — Capability Gaps

**What this document is.** A grounded, command-level diff between **Hermes Agent** (Nous Research;
the real installation present on this machine) and **Mercury Agent** (this repository at **v1.8.1**).

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
| 3 | **Mixture-of-Agents** | `moa` (aggregate answers across several model slots) | Router + teams, no MoA aggregation | Missing MoA provider |
| 4 | **Isolated profiles** | `profile` (multiple fully isolated instances) | Multi-user RBAC in one instance | No instance isolation |
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
| 15 | **Usage insights** | `insights` (analytics) | Token/cost accounting + `/metrics` | No insights command |
| 16 | **Agent Client Protocol** | `acp` (ACP server) | — | Missing |
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
7. **Isolated profiles (`mercury profile`)** — multiple isolated instances via `MERCURY_HOME`
   switching; mostly orchestration over the existing home-dir indirection.
8. **Usage insights (`mercury insights`)** — aggregate the token/cost ledger and run events already
   recorded into a reportable analytics view.

### Tier 3 — Strategic / ecosystem

9. **ACP server (`mercury acp`)** — expose Mercury over the Agent Client Protocol so external clients
   (editors, IDEs) can drive it; complements the existing MCP server.
10. **Mixture-of-Agents (`mercury moa`)** — aggregate/vote across model slots; a natural extension of
    the Jev router and teams.
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
- The Mercury side is this repository at **v1.8.1**. Re-run `hermes --help` and `mercury help` to
  refresh this diff after either side changes.
