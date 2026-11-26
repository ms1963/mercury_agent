# Profiles / isolated instances

Manage multiple **fully isolated** Mercury instances. A *profile* is a named instance with its own
**home directory** (`MERCURY_HOME`) — and therefore its own config, memory database, skills, plugins,
personalities and audit key. Nothing is shared between profiles. `mercury profile` builds on Mercury's
existing home-dir indirection (`MERCURY_HOME`) rather than inventing a parallel mechanism — it just
records which profile is active and resolves its home on the next run.

**Profile vs project — the layering.** A *profile* selects the **home**; a *project* (within that home)
selects the **data dir**. They stack:

```
profile  → selects MERCURY_HOME            (mercury profile)
  project → selects the data dir in that home   (mercury project)
```

Use a **profile** for a completely separate instance (e.g. work vs. personal, or a throwaway sandbox);
use a **project** for a workspace that shares the same instance but scopes memory/config per project.

Profiles are tracked in a **registry** at `~/.config/mercury/profiles.json`. Because profiles sit *above*
homes, the registry cannot live inside any single home — it lives in your config dir (override the
directory with `MERCURY_PROFILES_DIR`). Each profile defaults its home to `~/.mercury-profiles/<name>/`
(override the base with `MERCURY_PROFILES_HOME`), or you can point it anywhere with `--home`.

> **The built-in `default` profile** always exists and maps to the standard `~/.mercury`, so existing
> setups are completely unaffected until you create a profile. It cannot be created, removed or purged.

> **The switching mechanism (important).** A process cannot change its parent shell's environment, so
> `mercury profile use <name>` does **two** things: it persists the selection (new Mercury processes pick
> it up automatically on their next run) **and** it prints the exact `export MERCURY_PROFILE=<name>` line
> to apply the change to your *current* shell immediately — much like `pyenv`/`direnv`. Run (or `eval`)
> that line to switch the active instance in the shell you are in right now.

> **Precedence.** An explicit `MERCURY_HOME` always wins (profiles are ignored). Otherwise a
> `MERCURY_PROFILE` environment variable overrides the stored active profile for that run.

## List — `mercury profile list`

Lists every profile — the built-in `default` first, then your profiles sorted by name (active marker,
name, home dir, "home missing" when it has been deleted, and description).

- `mercury profile list` — human table; the active profile is marked with `*`.
- `mercury profile list --json` — emit the profiles as JSON: `{ name, home, description, createdAt,
  updatedAt, builtin, isActive, homeExists }` per profile.

## Create — `mercury profile create <name>`

Creates a profile and its home dir, and registers it.

- `mercury profile create work` — create `work` with the default home `~/.mercury-profiles/work/`.
- `mercury profile create work --use` — create it and make it active immediately.
- `mercury profile create work --home /srv/mercury/work` — use an explicit home dir instead of the default.
- `mercury profile create work --desc "Work instance"` — attach a short description.
- `--json` — emit the created profile as JSON.

Names must be a single safe segment (letters, digits, `.`, `_`, `-`; at most 64 characters; no path
separators, no `..`, no leading dot). Creating a name that already exists — or the reserved name
`default` — is refused.

## Use — `mercury profile use <name>`

Switches the active profile. The change is written to the registry (so new processes pick it up) and the
command prints the `export MERCURY_PROFILE=<name>` line to apply it to your current shell now.

- `mercury profile use work` — make `work` active, and print the export line.
- `mercury profile use default` — switch back to the standard `~/.mercury` instance.
- `--json` — print `{ active, home, export }`.

## Show — `mercury profile show [name]`

Shows one profile's details: home dir (and whether it exists), a count of entries currently in the home
dir, description and creation time. With no name, it shows the **active** profile (the built-in `default`
when none is selected, since that is the effective running instance).

- `mercury profile show` — show the active (or default) profile.
- `mercury profile show work` — show the profile named `work`.
- `--json` — emit the details (plus `homeEntries`) as JSON.

Naming an unknown profile is an error.

## Current — `mercury profile current`

Prints just the active profile's name (`default` when none is selected).

- `mercury profile current` — print the active name.
- `mercury profile current --json` — print `{ active }`.

## Remove — `mercury profile remove <name>`

Unregisters a profile. **Destructive, so it requires confirmation:**

- `mercury profile remove work --force` (or `--yes`) — unregister `work`. By default the **home dir is
  kept** on disk (only the registry entry is removed), so you can re-create the profile to recover it.
- `mercury profile remove work --force --purge` — also delete the profile's home dir from disk
  (extra-destructive — this cannot be undone). As a safety net the standard `~/.mercury` is never purged.
- Without `--force`/`--yes` the command refuses and exits non-zero (same gating as `mercury project
  remove` / `mercury sessions delete` / `mercury plugins remove`).
- The `default` profile cannot be removed.
- `--json` — print `{ name, home, purged, wasActive }`.

Removing the active profile clears the active selection (the `default` profile is active afterwards).

## Exit codes

`0` on success. A missing name, a duplicate on create, an invalid or reserved name, an unknown profile on
`use`/`show`/`remove`, a remove without `--force`, removing `default`, and an unknown subcommand all exit
non-zero.

## Storage

The registry is `~/.config/mercury/profiles.json` (override the directory with `MERCURY_PROFILES_DIR`).
Profile homes default to `~/.mercury-profiles/<name>/` (override the base with `MERCURY_PROFILES_HOME`, or
set an explicit path per profile with `--home`); the built-in `default` profile maps to `~/.mercury`. The
home-dir indirection is unchanged — this command only records which profile is active and resolves its
home; everything Mercury already keys off the home (config, memory DB, plugins, skills, audit key) is
thereby isolated per profile.
