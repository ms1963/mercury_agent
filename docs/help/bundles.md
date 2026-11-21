# Sharable agent bundles ("Mercury packs")

A bundle packages a Mercury configuration — a skill set, workflows, personality, policy-as-code and
MCP presets — into a single **versioned, signed** artifact you can hand to another instance and
install in one command. Bundles are **on by default** (`bundles.enabled: true`).

## What's in a bundle

A bundle is one JSON file with a `manifest`, the `contents` (only the sections you included) and a
`signature`. The sections are:

| Section       | Source config key    | Governed |
|---------------|----------------------|----------|
| `skills`      | `skills`             | no       |
| `workflows`   | `workflows`          | no       |
| `personality` | `agent.personality`  | no       |
| `policy`      | `security.policies`  | **yes**  |
| `mcp`         | `mcp.servers`        | **yes**  |

## Export

Export the current configuration (or a chosen subset of sections) into a bundle. The manifest
records the bundle's own version, the wire **format version**, and the **Mercury version** it was
exported from. The whole `{manifest, contents}` is signed with HMAC-SHA256.

## Inspect and install

**Inspect** shows the manifest, the content digest, whether the signature verifies and whether the
format/version are compatible — without changing anything.

**Install** is safe by construction:

- **Signature verification.** With `requireSignature: true` a bundle whose signature is missing or
  does not verify is rejected — tampering with any byte of the contents invalidates the signature.
- **Version/compatibility gating.** A bundle from a newer wire-format major is refused.
- **Idempotent.** Installs are keyed by content digest; re-installing the identical bundle is a
  no-op (`alreadyInstalled`, status `unchanged`).
- **Governed sections go through approval.** The ungoverned sections (skills, workflows,
  personality) are applied directly; `policy` and `mcp` are **queued for approval** instead of being
  applied silently, unless `autoApprovePolicy` / `autoApproveMcp` are explicitly turned on.

## CLI

```
mercury bundle list                                               installed bundles (ledger)
mercury bundle export <name> [--version v] [--sections a,b,c] [--out file] [--desc ...] [--author ...]
mercury bundle inspect <file>                                     verify signature + compatibility
mercury bundle install <file>                                     verify → install (governed)
```

Add `--json` to any subcommand for machine-readable output.

## API

- `GET /api/bundles` — status, config and the install ledger.
- `POST /api/bundles/export {name, version?, sections?, description?, author?}` — export and sign.
- `POST /api/bundles/inspect` — inspect a posted bundle without installing.
- `POST /api/bundles/install {bundle, source?}` — verify and install.
- `POST /api/bundles/:id/approve` — approve the governed sections queued by an install.

Programmatically the same is exposed via the `mercury.bundles` facade: `export`, `exportToFile`,
`read`, `inspect`, `install`, `approvePending`, `list`.

## Config

```yaml
bundles:
  enabled: true                               # master switch (facade, CLI and endpoints)
  dir: ''                                      # bundle storage dir; empty → <dataDir>/bundles
  signingSecret: 'mercury-bundle-default-key'  # HMAC signing secret — override in production
  requireSignature: true                       # reject missing/invalid signatures (tamper guard)
  autoApprovePolicy: false                     # apply bundled policy immediately (else queue)
  autoApproveMcp: false                        # apply bundled MCP presets immediately (else queue)
```

The Web UI **Agent Bundles** panel (admin) exports and downloads a bundle, inspects or installs one
(paste JSON or choose a file), and lists installed bundles with an approve action for governed
sections.
