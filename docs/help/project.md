# Projects / workspaces

Manage named **workspaces**. A *project* is a named workspace with its own **data dir**, so that
different projects never share state: the data dir is where Mercury keeps its memory database, config,
plugins, skills and audit key, so pointing it at a per-project folder scopes **config and memory**
together in one move. `mercury project` builds on Mercury's existing data-dir indirection
(`MERCURY_HOME` / `MERCURY_DATA_DIR`) rather than inventing a parallel mechanism — it just records which
project is active and resolves its data dir on the next run.

Projects are tracked in a **registry** at `~/.mercury/projects.json` (the Mercury *home*, not any one
project's data dir — switching has to live above the per-project dirs). Each project defaults its data
dir to `~/.mercury/projects/<name>/`, or you can point it anywhere with `--dir`.

> The active project applies the **next time** Mercury (or the server) starts — switching does not move
> the running process to a different data dir. An explicit `MERCURY_DATA_DIR`, or a `MERCURY_PROJECT`
> environment variable naming a registered project, overrides the stored active project.

> Switching does **not** migrate data. Each project keeps its own memory DB, config, plugins and skills;
> there is no automatic copy between projects.

## List — `mercury project list`

Lists every registered project (active marker, name, data dir, "data dir missing" when it has been
deleted, and description).

- `mercury project list` — human table; the active project is marked with `*`.
- `mercury project list --json` — emit the projects as JSON: `{ name, dataDir, folders, description,
  createdAt, updatedAt, isActive, dataDirExists }` per project.

## Create — `mercury project create <name>`

Creates a project, its data dir and any extra folders, and registers it.

- `mercury project create web` — create `web` with the default data dir `~/.mercury/projects/web/`.
- `mercury project create web --use` — create it and make it active immediately.
- `mercury project create web --dir /srv/mercury/web` — use an explicit data dir instead of the default.
- `mercury project create web --folder ./frontend,./backend` — associate extra working folder(s)
  (comma-separated; each is created if missing).
- `mercury project create web --desc "Customer portal"` — attach a short description.
- `--json` — emit the created project as JSON.

Names must be a single safe segment (letters, digits, `.`, `_`, `-`; at most 64 characters; no path
separators, no `..`, no leading dot). Creating a name that already exists is refused.

## Use — `mercury project use <name>`

Switches the active project. The change is written to the registry and applies on the next run.

- `mercury project use web` — make `web` active.
- `--json` — print `{ active, dataDir }`.

## Show — `mercury project show [name]`

Shows one project's details: data dir (and whether it exists), a count of entries currently in the data
dir, associated folders, description and creation time. With no name, it shows the **active** project.

- `mercury project show` — show the active project (or a hint if none is active).
- `mercury project show web` — show the project named `web`.
- `--json` — emit the details (plus `dataDirEntries`) as JSON.

Naming an unknown project is an error; asking for the active project when none is set prints a hint
(and `{ "active": null }` with `--json`).

## Current — `mercury project current`

Prints just the active project's name, or `(none)`.

- `mercury project current` — print the active name or `(none)`.
- `mercury project current --json` — print `{ active }` (`null` when none).

## Remove — `mercury project remove <name>`

Unregisters a project. **Destructive, so it requires confirmation:**

- `mercury project remove web --force` (or `--yes`) — unregister `web`. By default the **data dir is
  kept** on disk (only the registry entry is removed), so you can re-create the project to recover it.
- `mercury project remove web --force --purge` — also delete the project's data dir from disk
  (extra-destructive — this cannot be undone).
- Without `--force`/`--yes` the command refuses and exits non-zero (same gating as `mercury sessions
  delete` / `mercury plugins remove`).
- `--json` — print `{ name, dataDir, purged, wasActive }`.

Removing the active project clears the active selection (no project is active afterwards).

## Exit codes

`0` on success. A missing name, a duplicate on create, an invalid name, an unknown project on
`use`/`show`/`remove`, a remove without `--force`, and an unknown subcommand all exit non-zero.

## Storage

The registry is `~/.mercury/projects.json`. Project data dirs default to `~/.mercury/projects/<name>/`
(or wherever `--dir` points). The data-dir indirection is unchanged — this command only records which
project is active and resolves its data dir; everything Mercury already keys off the data dir (memory
DB, config, plugins, skills) is thereby scoped per project.
