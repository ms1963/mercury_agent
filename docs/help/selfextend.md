# Self-extending tools (dynamic tool synthesis)

`mercury selfextend` lets Mercury **draft a brand-new tool** when a capability is repeatedly needed
but no registered tool provides it. This is a **high-risk** feature: Mercury is writing and running
code it authored itself. For that reason it is **DISABLED BY DEFAULT** and every step of the pipeline
is gated.

> While `selfExtension.enabled = false` (the default), the whole subsystem is a hard no-op: no gaps
> are tracked, no drafts are authored, nothing is registered, and the CLI/Web/API surfaces reply with
> a localized "disabled" message. The master switch is the kill-switch.

## The pipeline (every step gated)

1. **Gap detection (threshold).** When a tool call fails because no tool matches, the runtime emits a
   `tool.miss` event. A gap is only considered *real* once the same capability has been missed
   `selfExtension.missThreshold` times (default **3**). This prevents one-off misses from triggering
   synthesis.
2. **Authoring (LLM).** An injected LLM runner is asked to author a draft: a tool name, description,
   input schema, an implementation (Python or Node), a **generated unit test**, and a
   **least-privilege capability manifest** declaring exactly what the tool needs (filesystem /
   network / specific hosts / shell).
3. **Validation (before registration).** The draft must pass, in order:
   - **Manifest policy (deny-by-default):** every capability the draft requests must be explicitly
     granted in config. A draft that asks for an undeclared or disallowed capability is **rejected** —
     Mercury never widens its own privileges.
   - **Compile check:** the implementation must compile (`python3 -m py_compile` / `node --check`),
     run out-of-process with a scrubbed environment and a timeout.
   - **Generated unit test:** the test authored alongside the tool must pass, again out-of-process.

   A draft that fails any stage never becomes a registered tool.
4. **Approval gating.** A validated draft is stored as **PENDING**. It cannot run until a human
   approves it (`selfextend approve <id>`), unless `selfExtension.autoApprove = true` is explicitly
   configured. Denial (`selfextend deny <id>`) marks it permanently unrunnable and removes any
   persisted folder.
5. **Sandboxed execution.** Approved tools persist as **polyglot tool folders** (`tool.json` +
   `main.py` / `main.mjs`) under `<dataDir>/synth-tools/` and run **out-of-process** behind the
   existing sandbox boundary — never `eval`'d in the main runtime. The environment is scrubbed of
   secrets, network is unavailable unless the manifest declared it, and output/time are capped.
6. **Provenance & audit.** Every author / validate / approve / deny / run is recorded in the audit
   log, and each tool folder keeps a `.synth.json` with its provenance (capability, prompt digest,
   manifest, validation result, approver).
7. **Persistence.** Approved tools reload automatically on the next launch, so the capability survives
   across sessions.

## Usage

```
mercury selfextend status [--json]
mercury selfextend enable | disable
mercury selfextend list [pending|approved|denied] [--json]
mercury selfextend gaps [--json]
mercury selfextend synthesize <capability...> [--json]
mercury selfextend approve <id>
mercury selfextend deny <id>
```

- `status` — show whether the feature is enabled and the current policy + counts. `--json` for raw.
- `enable` / `disable` — toggle `selfExtension.enabled` in the config file (the master kill-switch).
- `list [state]` — list synthesized tools, optionally filtered by `pending` / `approved` / `denied`.
- `gaps` — list tracked capability gaps, most-missed first.
- `synthesize <capability...>` — author + validate a tool for a capability now (creates a PENDING
  record). Fails loudly if the feature is disabled.
- `approve <id>` — approve a validated tool for its first run (persists + hot-registers it).
- `deny <id>` — deny a tool (it can never run) and remove any persisted folder.

## Configuration

Under `selfExtension:` in the config file:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Master kill-switch. Everything is a no-op while false. |
| `missThreshold` | `3` | How many misses of the same capability before a gap is actionable. |
| `autoApprove` | `false` | If true, validated tools are approved automatically (NOT recommended). |
| `allowFilesystem` | `false` | Allow drafts to declare filesystem access. |
| `allowNetwork` | `false` | Allow drafts to declare network access. |
| `allowedHosts` | `[]` | Exact hosts or `*.suffix` wildcards a networked draft may reach. |
| `allowShell` | `false` | Allow drafts to declare shell access (strongly discouraged). |
| `runtimes` | `['python','node']` | Which runtimes a draft may target. |
| `timeoutMs` | `15000` | Per-execution wall-clock limit (compile, test, and run). |
| `maxOutputChars` | `20000` | Output cap per execution. |
| `dir` | *(dataDir/synth-tools)* | Where approved tool folders persist. |

You can also toggle the feature from the Web UI (**Self-Extend** panel, admin only) and via the API
(`GET /api/selfextend`, `POST /api/selfextend/toggle`, `POST /api/selfextend/:id/approve|deny`).

## Safety / threat model

See the dedicated threat-model section in `docs/HANDBOOK.md` and `docs/GAPS.md`. In short, the
mitigations are: **disabled by default (kill-switch)**, **deny-by-default capability manifest**,
**no ambient secrets** passed to generated code, **mandatory approval before first run**, a
**validation + generated-test gate before registration**, **out-of-process sandboxed execution**
(never `eval`), **resource/time/output limits**, a **full audit trail with provenance**, and
**refusal of over-privileged drafts**.

### Honest status

The infrastructure (gap detection, authoring contract, validation gate, approval gating, policy,
persistence, audit, CLI/Web/API, i18n) is implemented and covered by offline tests that use stubbed
LLM runners and real local compile/test runners. What is **not** verified in CI: the quality of
drafts produced by a real production LLM, and execution inside the full polyglot/Docker host sandbox
(CI exercises the lighter host child-process compile/test path). Treat real-LLM authoring and
production-sandbox execution as experimental.
