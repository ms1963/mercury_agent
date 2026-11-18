# Permissions: per-agent / per-personality profiles

Mercury has always had **per-user** policies (`UserPolicy`: `allowedTools`, `deniedTools`,
`deniedToolsets`, `allowedModels`, `deniedModels`, `allowedWorkflows`, `maxToolRisk`).
This document covers the **per-agent / per-personality permission profiles** added on top,
and the exact merge semantics.

A **permission profile** is a `UserPolicy`-shaped object attached to a personality/agent
*name*. When an agent runs under a given personality, that personality's profile also
applies — so you can, for example, give a "pirate" personality no shell access even for a
user who normally has it.

> Status (v0.2.0): the merge function `effectivePolicy` and its enforcement through
> `PolicyEngine` are covered by offline unit tests (`tests/permissions.test.ts`). The
> declarative loading from `<dataDir>/permissions/` and add-in manifests is unit-tested in
> `tests/addins.test.ts`. No "production-ready" claim is made.

## The core rule: a profile can only *further restrict*, never escalate

The effective policy for a request is the **intersection / most-restrictive combination**
of the acting user's base policy and the personality profile. A profile can shrink what a
user may do; it can **never** grant something the user is not already allowed.

| Field | Combination | Meaning |
|---|---|---|
| `deniedTools` | **union** | denied by either ⇒ denied |
| `deniedToolsets` | **union** | denied by either ⇒ denied |
| `deniedModels` | **union** | denied by either ⇒ denied |
| `maxToolRisk` | **minimum** | the lower (safer) cap wins; `undefined` = no cap |
| `allowedTools` | **intersection** | effective allow-list ⊆ both; one-sided list applies as-is |
| `allowedModels` | **intersection** | as above |
| `allowedWorkflows` | **intersection** | as above |

Allow-list intersection keeps only entries each side also permits. Plain names behave as a
set intersection; glob patterns (e.g. `mcp__github__*`) are kept when matched by the other
side. The result is therefore never wider than either input list.

Passing no profile returns the user policy unchanged (fully backward compatible). **Admins
bypass ABAC restrictions entirely**, profile or not.

## Worked example

User `alice` base policy:

```yaml
allowedTools: [web_search, read_file, bash]
maxToolRisk: dangerous
```

Personality profile `researcher`:

```yaml
allowedTools: [web_search, read_file, write_file]
deniedToolsets: [shell]
maxToolRisk: moderate
```

Effective policy when alice runs under `researcher`:

```yaml
allowedTools: [web_search, read_file]   # intersection — write_file isn't alice's; bash isn't the profile's
deniedToolsets: [shell]                  # union
maxToolRisk: moderate                    # min(dangerous, moderate)
```

So under `researcher`, alice can `web_search` and `read_file`, **cannot** run `bash`
(`write_file` was never hers to begin with, and `shell` is denied), and is capped at
`moderate` risk even though she personally may run `dangerous` tools.

## Where profiles come from (declarative, no source edits)

Two additive sources, merged (add-in profiles win on a name clash):

1. **`<dataDir>/permissions/*.yaml` (or `.yml`/`.json`)** — each file is either:
   - a single policy, whose **file name** (without extension) is the profile name:
     ```yaml
     # <dataDir>/permissions/researcher.yaml
     allowedTools: [web_search, read_file, write_file]
     deniedToolsets: [shell]
     maxToolRisk: moderate
     ```
   - or a `{ name: policy, ... }` map in one file:
     ```yaml
     reader:  { allowedTools: [web_search] }
     writer:  { maxToolRisk: moderate }
     ```
2. **Add-in manifests** — the `permissions:` section of an `addin.yaml` (see
   [ADDINS.md](ADDINS.md)).

Relocate with the `permissions.dir` config key (empty ⇒ `<dataDir>/permissions`). Invalid
files are skipped with a warning, never thrown.

## CLI

```bash
mercury perms list                 # configured profile names
mercury perms show researcher      # a profile's policy + a note on effective-policy merge
mercury perms list --json
```

`perms show` prints the profile as stored. The *effective* policy at runtime additionally
depends on the acting user's own base policy, per the merge table above.

## How enforcement is wired

`PolicyEngine` resolves profiles via a `profileOf(name)` lookup and computes
`effectivePolicy(userPolicy, profile)` on every `tool.use` / `model.use` / `workflow.run`
check. The agent passes the active personality name into the authorization context, so the
personality's restrictions apply automatically. Existing per-user enforcement is unchanged
and never loosened.
