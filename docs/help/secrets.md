# External secret stores

Resolve secrets from **external stores** instead of writing plaintext into your config. A config value may
embed a secret **reference** — `${SECRET:...}` — which Mercury expands to the real value at **connect
time** (for example, just before an MCP server is launched). The config file only ever holds the
reference, never the secret itself.

This complements the MCP preset `${ENV_VAR}` substitution rather than replacing it: `${ENV_VAR}` is
substituted once, at preset-enable time, and the concrete value is stored; `${SECRET:...}` stays in the
config and is resolved live on every run. The two coexist — secret resolution only ever touches
`${SECRET:...}` and leaves bare `${ENV_VAR}` placeholders alone.

## Reference syntax

- `${SECRET:backend:key}` — resolve `key` through the named `backend`
  (e.g. `${SECRET:op:op://vault/item/field}`).
- `${SECRET:key}` — resolve `key` through the **default backend** (config `secrets.defaultBackend`,
  default `env`).

A reference passed to `mercury secrets get` may be the bare inner spec (`backend:key` or `key`) or the
full `${SECRET:...}` wrapper.

## Backends

A backend maps a key to a value. Built in:

- **env** — reads from the process environment. Always available.
- **bitwarden** — the Bitwarden CLI: `bw get password <key>`. Opt-in via `secrets.bitwarden.enabled`.
- **onepassword** — the 1Password CLI: `op read <op://vault/item/field>`. Opt-in via
  `secrets.onepassword.enabled`.

The external-CLI backends invoke their tool through an injected command runner, so unit tests never shell
out. Aliases are accepted on the command line and in references: `bw` → `bitwarden`, `op` / `1password` →
`onepassword`.

## Configuration

Add a `secrets` section to your config (all fields optional):

```yaml
secrets:
  defaultBackend: env            # backend for a bare ${SECRET:key}
  bitwarden:
    enabled: false               # set true to use ${SECRET:bw:...}
    command: bw                  # override the CLI binary/path
  onepassword:
    enabled: false               # set true to use ${SECRET:op:...}
    command: op
```

Only enabled backends are available to the resolver, so a reference never implies a store the operator did
not opt into. `env` is always present.

## Backends — `mercury secrets backends`

Lists the configured backends and whether each is available right now (e.g. whether the CLI is installed).
The default backend is marked with `*`.

- `mercury secrets backends` — human table.
- `mercury secrets backends --json` — emit `{ name, describe, available, default }` per backend.

## List — `mercury secrets list`

Scans the **live config** for `${SECRET:...}` references and reports each one's resolve status, with the
value masked.

- `mercury secrets list` — human table (`resolved` / `UNRESOLVED`, the reference, and a masked value or
  the error).
- `mercury secrets list --json` — emit `{ ref, backend, key, status, value, error? }` per reference
  (`value` is always masked).

Exits non-zero if any reference is unresolved.

## Get — `mercury secrets get <ref>`

Resolves a single reference and prints it. **The value is masked by default** — only `--reveal` prints the
raw secret.

- `mercury secrets get env:API_KEY` — print `********` (resolved but masked).
- `mercury secrets get env:API_KEY --reveal` — print the raw value (sensitive — avoid in shared terminals
  or logs).
- `mercury secrets get '${SECRET:op:op://v/i/f}'` — the full wrapper form is accepted too.
- `--json` — emit `{ ref, backend, key, status, revealed, value }` (value masked unless `--reveal`).

Exits non-zero (and prints an error) if the reference cannot be resolved.

## Resolve — `mercury secrets resolve [--config <path>]`

Scans a config and reports which `${SECRET:...}` references resolve, masked. With no `--config`, it scans
the live config; with `--config <path>` it scans that file's text (format-agnostic).

- `mercury secrets resolve` — scan the live config.
- `mercury secrets resolve --config ./mcp.yaml` — scan a specific file.
- `--json` — emit `{ source, refs: [{ ref, backend, key, status, value, error? }] }`.

Exits non-zero if any reference is unresolved.

## Safety

No command ever persists or logs a plaintext secret. Output is masked everywhere by default; the **only**
way to print a raw value is `mercury secrets get --reveal`. At connect time, an unresolved reference is
left in place (so the failure is visible) and only the **count** of unresolved references is logged — never
the keys or values.

## Exit codes

`0` on success. `secrets get` exits non-zero when the reference cannot be resolved; `secrets list` and
`secrets resolve` exit non-zero when any reference is unresolved; an unknown subcommand exits non-zero.

## Connect-time integration

When Mercury starts, MCP server configs are expanded through the resolver before the servers are launched,
so `${SECRET:...}` references in a server's `command`, `args`, `env` or `headers` become real values in the
spawned process — without the secret ever being written to disk. The same resolver is exposed as a library
(`secretResolverFromConfig`, `expandSecretsDeep`, `scanSecretRefs`) and exercised directly by
`mercury secrets resolve`.
