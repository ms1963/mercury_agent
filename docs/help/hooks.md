# Shell hooks

`mercury hooks` runs a configured **shell command at a real lifecycle event** (run start/end, tool
calls, memory writes, …). Every hook that shells out is routed through the **approvals layer BEFORE the
command is spawned** — the same gate every other shell-out in Mercury uses — unless you explicitly opt
out per hook with `--no-approval`.

Hooks are stored in the config file under `hooks:` (as entries with `type: shell`). They fire from the
runtime automatically at the bound event, and can also be fired manually for testing with `hooks run`.

## Lifecycle events

A hook binds to one of the real interception points (list them with `mercury hooks events`):

- `run_start`, `run_end` — an agent run begins / ends
- `before_llm_call`, `after_llm_call` — around each model call
- `before_tool_call`, `after_tool_call` — around each tool call
- `message_received`, `message_sent` — gateway traffic
- `output` — final output produced
- `memory_write` — a memory item is written
- `attachment_scan` — an attachment is scanned
- `error` — a run errors

Use `*` to bind a hook to **every** event.

## Environment passed to the command

The command runs via `sh -c` with the current environment plus these variables (only those the firing
event actually carries are set; `MERCURY_HOOK_EVENT` and `MERCURY_HOOK_TS` are always set):

`MERCURY_HOOK_EVENT`, `MERCURY_HOOK_TS`, `MERCURY_RUN_ID`, `MERCURY_SESSION_ID`, `MERCURY_USER_ID`,
`MERCURY_TOOL`, `MERCURY_MODEL`, `MERCURY_STATUS`, `MERCURY_PLATFORM`.

## Usage

```
mercury hooks list [--json]
mercury hooks events [--json]
mercury hooks add <name> --event <event> --command <cmd> [--no-approval] [--disabled]
mercury hooks remove <name> [--force]
mercury hooks run <name> [--json]
```

- `list` — show configured shell hooks (name, event, enabled, approval, command). `--json` for raw.
- `events` — list the supported lifecycle event names. `--json` for raw.
- `add <name>` — register (or overwrite) a hook. `--event` and `--command` are required;
  `--no-approval` runs it without the approval gate; `--disabled` registers it inactive.
- `remove <name>` — delete a hook; requires `--force`.
- `run <name>` — fire a hook now for testing (still approval-gated). Prints the result plus any
  stdout/stderr; exits non-zero when the hook is denied, fails, or errors.

## Safety

Shell hooks execute **arbitrary commands on the host**. Approval gating is **on by default**;
`--no-approval` disables it for a single hook — reserve that for trusted, non-destructive commands.
A denied hook never spawns; a failing or erroring hook is reported but never crashes the run.
