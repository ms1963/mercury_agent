# Plugin management

Manage the plugins Mercury loads from `~/.mercury/plugins/`. `mercury plugins` **lists** the plugins
Mercury loaded this run, and **installs / updates / removes** plugins from a local path or a git URL. It
builds on Mercury's existing plugin loader (`discoverPlugins` / `loadPlugin`) and scaffolder
(`mercury new plugin`) — it does not change how plugins are discovered or loaded.

A *plugin* is a directory under `~/.mercury/plugins/<name>/` with a discoverable entry point
(`index.js`, `index.mjs`, `dist/index.js`, or a `package.json` `main`/`module` pointing at a file that
exists). A single-file plugin is installed as `<name>/<name>.js`.

Each plugin installed through this command gets an **install manifest** (`.mercury-plugin.json`) written
into its directory, recording where it came from (git URL or absolute path), its version and timestamps.
`update` reads the manifest to decide between a `git pull` and a re-copy from the recorded path. Plugins
dropped in by hand (no manifest) still load and list, but cannot be updated.

> Changes take effect the next time Mercury (or the server) starts — installing, updating or removing a
> plugin does not hot-reload the running process.

## List — `mercury plugins` / `mercury plugins list`

Lists the plugins Mercury loaded this run (name, version, and any load error).

- `mercury plugins` — list loaded plugins (bare form).
- `mercury plugins list` — same.
- `mercury plugins list --json` — emit the **installed** plugins (from disk, with manifest + entry info)
  as JSON: `{ name, path, version, source, entryPresent, managed }` per plugin.

## Install — `mercury plugins install <path|git-url>`

Installs a plugin into `~/.mercury/plugins/<name>/`.

- `mercury plugins install ./my-plugin` — copy a local plugin directory.
- `mercury plugins install ./my-plugin.js` — install a single-file plugin as `<name>/<name>.js`.
- `mercury plugins install https://github.com/acme/cool-plugin.git` — `git clone` the repository.
- `mercury plugins install git@github.com:acme/cool-plugin.git` — scp-style git URL.
- `mercury plugins install git+https://github.com/acme/cool.git` — `git+` prefix (stripped before clone).

Flags:

- `--name <name>` — override the derived install name. By default the name is the repo basename (minus
  `.git`) for git, or the directory/file basename for a path. Names must be a single safe segment
  (letters, digits, `.`, `_`, `-`; no path separators, no `..`, no leading dot).
- `--force` — overwrite an existing install of the same name (remove + reinstall). Without it, an existing
  install is refused.
- `--build` — run `npm install && npm run build` in the plugin directory, **only if** it declares a
  `build` script in its `package.json`. (Never touches the Mercury repo itself.)
- `--json` — print `{ name, dir, source, version, built, reinstalled }`.

A local source is validated before anything is written: the path must exist, and a directory source must
actually look like a plugin (have a discoverable entry point). A git source is validated after the clone;
a repository that does not look like a plugin is removed again and rejected.

## Update — `mercury plugins update <name>` / `--all`

Updates an installed plugin from its recorded source (requires a manifest).

- `mercury plugins update cool-plugin` — `git pull --ff-only` for a git source, or re-copy from the
  recorded path for a path source.
- `mercury plugins update --all` — update every *managed* plugin (those with a manifest), reporting each.
- `--json` — print the update result(s).

Updating fails if the plugin is not installed, has no manifest, or (for a path source) its original source
directory no longer exists.

## Remove — `mercury plugins remove <name>`

Removes an installed plugin directory. **Destructive, so it requires confirmation:**

- `mercury plugins remove cool-plugin --force` (or `--yes`) — delete the plugin directory.
- Without `--force`/`--yes` the command refuses and exits non-zero (same gating as `mercury sessions
  delete`).
- `--json` — print `{ name, dir }`.

## Exit codes

`0` on success. A missing source, duplicate install without `--force`, unknown/unmanaged plugin on update,
a remove without `--force`, and an unknown subcommand all exit non-zero.

## Storage

Plugins live under `~/.mercury/plugins/<name>/`. The per-plugin install manifest is `.mercury-plugin.json`
inside each managed plugin's directory. Loading and discovery are unchanged — this command only installs,
updates, removes and lists the files the loader already reads.
