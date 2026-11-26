/**
 * Plugin lifecycle management for Mercury (Tier-1 gap #4).
 *
 * Mercury already *loads* and *discovers* plugins ({@link ./plugin.js | plugin.ts}) and *scaffolds* new
 * ones (`mercury new plugin`). This module closes the loop with install / update / remove of plugins from
 * a **local path** or a **git URL**, tracked by a per-plugin install manifest so updates know where a
 * plugin came from.
 *
 * Plugins live in `<dataDir>/plugins/<name>/`. Each managed install drops a {@link PLUGIN_MANIFEST}
 * (`.mercury-plugin.json`) into the plugin directory recording its source, version and timestamps; this
 * is what `update` reads to decide between a `git pull` and a re-copy from the recorded path.
 *
 * The module is split into PURE functions (no fs, no process — fully unit-testable) and a thin fs/exec
 * layer that accepts an INJECTED command runner and clock, so tests never shell out or hit the network:
 *   - {@link parseSource}, {@link deriveName}, {@link validateName}  — source/name resolution (pure)
 *   - {@link isPluginDir}                                            — "is this actually a plugin?" (fs)
 *   - {@link installPlugin}, {@link updatePlugin}, {@link removePlugin}, {@link listInstalled} — lifecycle
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { errorMessage } from '../types/common.js';

/** Filename of the per-plugin install manifest written into each managed plugin directory. */
export const PLUGIN_MANIFEST = '.mercury-plugin.json';

/** Where a plugin came from. */
export type PluginSourceType = 'path' | 'git';

/** The resolved source of a plugin install (parsed from the user's source string). */
export interface PluginSource {
  type: PluginSourceType;
  /** For `git`: the clone URL. For `path`: the absolute resolved source path. */
  location: string;
  /** True when a `path` source points at a single `.js`/`.mjs` file rather than a directory. */
  singleFile?: boolean;
}

/** The install manifest persisted as `.mercury-plugin.json` inside a managed plugin directory. */
export interface PluginManifest {
  name: string;
  source: PluginSource;
  version?: string;
  installedAt: string;
  updatedAt?: string;
}

/** One installed plugin as reported by {@link listInstalled}. */
export interface InstalledPlugin {
  name: string;
  path: string;
  version?: string;
  source?: PluginSource;
  entryPresent: boolean;
  managed: boolean;
}

/**
 * A command runner abstraction so the fs/exec layer is testable. The default real runner
 * ({@link defaultRunner}) shells out with `execFileSync`; tests inject a fake that records calls and
 * fabricates a cloned directory on `git clone`.
 */
export type CommandRunner = (cmd: string, args: string[], opts: { cwd?: string }) => void;

/** A clock injection (ISO string), so install/update timestamps are deterministic in tests. */
export type Clock = () => string;

/** The real command runner — runs `cmd args` synchronously, inheriting stdio, throwing on failure. */
export const defaultRunner: CommandRunner = (cmd, args, opts) => {
  execFileSync(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
};

// ───────────────────────────────── pure layer (no fs) ─────────────────────────────────

const GIT_SSH_RE = /^[^@]+@[^:]+:.+/; // git@host:owner/repo(.git)
const GIT_URL_RE = /^(https?|ssh|git):\/\/.+\/.+/;

/**
 * Classify a source string as a git URL or a local path (pure). A source is treated as git when it
 * starts with `git+`, ends with `.git`, is an `scp`-style `git@host:owner/repo`, or is an
 * `http(s)/ssh/git` URL with a path. Everything else is a local path (resolved to absolute).
 */
export function parseSource(src: string): PluginSource {
  const s = src.trim();
  if (!s) throw new Error('empty plugin source');
  let git = false;
  let location = s;
  if (s.startsWith('git+')) {
    git = true;
    location = s.slice(4);
  } else if (s.endsWith('.git') || GIT_SSH_RE.test(s) || GIT_URL_RE.test(s)) {
    git = true;
  }
  if (git) return { type: 'git', location };
  const abs = resolve(s);
  return { type: 'path', location: abs };
}

/** Strip a trailing `.git` and any `#ref`/trailing slashes from a git location for name derivation. */
function gitRepoBase(location: string): string {
  let loc = location.replace(/#.*$/, '').replace(/\/+$/, '');
  loc = loc.replace(/\.git$/, '');
  // Take the last path segment (handles both `/` and scp-style `:` separators).
  const seg = loc.split(/[/:]/).filter(Boolean).pop() ?? '';
  return seg;
}

/**
 * Derive the install name for a plugin (pure). An explicit name wins. For git, use the repo basename
 * (minus `.git`); for a path, the basename (minus a `.js`/`.mjs` extension for single-file installs).
 * The result is validated by {@link validateName}.
 */
export function deriveName(source: PluginSource, explicit?: string): string {
  let name: string;
  if (explicit && explicit.trim()) {
    name = explicit.trim();
  } else if (source.type === 'git') {
    name = gitRepoBase(source.location);
  } else {
    name = basename(source.location).replace(/\.(m?js)$/, '');
  }
  return validateName(name);
}

/**
 * Validate a plugin install name: it must be a safe single directory segment — no path separators, no
 * `..` traversal, no leading dot, only `[A-Za-z0-9._-]`. Returns the name on success; throws otherwise.
 */
export function validateName(name: string): string {
  const n = (name ?? '').trim();
  if (!n) throw new Error('could not determine a plugin name (pass --name <name>)');
  if (n === '.' || n === '..' || n.startsWith('.')) throw new Error(`invalid plugin name "${n}"`);
  if (n.includes('/') || n.includes('\\')) throw new Error(`invalid plugin name "${n}" (no path separators)`);
  if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`invalid plugin name "${n}" (allowed: letters, digits, . _ -)`);
  return n;
}

/** Read a `main`/`module` field from a parsed package.json-like object, if any. */
function pkgEntry(pkg: Record<string, unknown> | undefined): string | undefined {
  const main = pkg?.main;
  const mod = pkg?.module;
  return typeof main === 'string' ? main : typeof mod === 'string' ? mod : undefined;
}

// ───────────────────────────────── fs layer (thin) ─────────────────────────────────

/** Read + JSON-parse a file, returning undefined on any error (missing/malformed). */
function readJson<T = Record<string, unknown>>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The package.json of a plugin directory, if present and parseable. */
function readPackageJson(dir: string): Record<string, unknown> | undefined {
  return readJson(join(dir, 'package.json'));
}

/**
 * Whether `dir` (a directory) looks like a loadable plugin: it has a discoverable entry point the same
 * way {@link ./plugin.js | discoverPlugins} finds one (`index.js|.mjs` or `dist/index.js`), OR a
 * package.json whose `main`/`module` entry exists on disk.
 */
export function isPluginDir(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const idx = ['index.js', 'index.mjs', 'dist/index.js'].map((f) => join(dir, f)).find(existsSync);
  if (idx) return true;
  const entry = pkgEntry(readPackageJson(dir));
  if (entry && existsSync(join(dir, entry))) return true;
  return false;
}

/** The version recorded in a plugin directory's package.json, if any. */
function dirVersion(dir: string): string | undefined {
  const v = readPackageJson(dir)?.version;
  return typeof v === 'string' ? v : undefined;
}

/** Read a plugin directory's install manifest, if present. */
export function readManifest(pluginDir: string): PluginManifest | undefined {
  return readJson<PluginManifest>(join(pluginDir, PLUGIN_MANIFEST));
}

/** Write (or overwrite) a plugin directory's install manifest. */
function writeManifest(pluginDir: string, manifest: PluginManifest): void {
  writeFileSync(join(pluginDir, PLUGIN_MANIFEST), JSON.stringify(manifest, null, 2));
}

/** Options for {@link installPlugin}. */
export interface PluginInstallOptions {
  /** Explicit install name (overrides derivation). */
  name?: string;
  /** Overwrite an existing install of the same name (remove + reinstall). */
  force?: boolean;
  /** Run `npm install && npm run build` in the plugin dir, only if it declares a `build` script. */
  build?: boolean;
  runner?: CommandRunner;
  clock?: Clock;
}

/** The result of a successful {@link installPlugin}. */
export interface PluginInstallResult {
  name: string;
  dir: string;
  source: PluginSource;
  version?: string;
  built: boolean;
  reinstalled: boolean;
}

/**
 * Install a plugin from a local path or git URL into `<pluginsDir>/<name>/`, writing an install manifest.
 *
 * - Resolves the source + name (pure), then validates a **local** source exists and (for a directory)
 *   actually looks like a plugin BEFORE touching the destination.
 * - If the destination exists: refuses unless `force`, in which case it removes and reinstalls.
 * - Local directory → `cpSync` recursive; local single file → copied to `<dir>/<name>.js`; git → the
 *   injected runner runs `git clone <url> <dest>`.
 * - Optional `build`: only when the plugin's package.json declares a `build` script — runs `npm install`
 *   then `npm run build` in the plugin dir via the runner (never touches the Mercury repo).
 */
export function installPlugin(pluginsDir: string, src: string, opts: PluginInstallOptions = {}): PluginInstallResult {
  const runner = opts.runner ?? defaultRunner;
  const clock = opts.clock ?? (() => new Date().toISOString());
  const source = parseSource(src);
  const name = deriveName(source, opts.name);
  const dir = join(pluginsDir, name);

  // Validate a local source up front (a git source is validated after clone).
  if (source.type === 'path') {
    if (!existsSync(source.location)) throw new Error(`source path not found: ${source.location}`);
    const isDir = statSync(source.location).isDirectory();
    source.singleFile = !isDir;
    if (isDir && !isPluginDir(source.location)) {
      throw new Error(
        `"${source.location}" does not look like a plugin (no index.js/.mjs, dist/index.js, or package.json main)`,
      );
    }
    if (!isDir && !/\.(m?js)$/.test(source.location)) {
      throw new Error(`single-file plugin source must be a .js or .mjs file: ${source.location}`);
    }
  }

  const existed = existsSync(dir);
  if (existed && !opts.force) {
    throw new Error(`plugin "${name}" is already installed at ${dir} (use --force to overwrite)`);
  }
  if (existed) rmSync(dir, { recursive: true, force: true });

  // Place the files.
  if (source.type === 'git') {
    mkdirSync(pluginsDir, { recursive: true });
    try {
      runner('git', ['clone', source.location, dir], { cwd: pluginsDir });
    } catch (err) {
      throw new Error(`git clone failed: ${errorMessage(err)}`);
    }
    if (!isPluginDir(dir)) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`cloned repository "${source.location}" does not look like a plugin`);
    }
  } else if (source.singleFile) {
    mkdirSync(dir, { recursive: true });
    cpSync(source.location, join(dir, `${name}.js`));
  } else {
    mkdirSync(pluginsDir, { recursive: true });
    cpSync(source.location, dir, { recursive: true });
  }

  // Optional build step (gated on a declared build script).
  let built = false;
  if (opts.build) {
    const scripts = readPackageJson(dir)?.scripts as Record<string, unknown> | undefined;
    if (scripts && typeof scripts.build === 'string') {
      runner('npm', ['install'], { cwd: dir });
      runner('npm', ['run', 'build'], { cwd: dir });
      built = true;
    }
  }

  const version = dirVersion(dir);
  const manifest: PluginManifest = { name, source, version, installedAt: clock() };
  writeManifest(dir, manifest);
  return { name, dir, source, version, built, reinstalled: existed };
}

/** Options for {@link updatePlugin}. */
export interface PluginUpdateOptions {
  runner?: CommandRunner;
  clock?: Clock;
}

/** The result of a successful {@link updatePlugin}. */
export interface PluginUpdateResult {
  name: string;
  dir: string;
  source: PluginSource;
  version?: string;
  method: 'git-pull' | 'recopy';
}

/**
 * Update an installed plugin from its recorded source. Requires a managed install (a manifest must
 * exist). A `git` source runs `git -C <dir> pull --ff-only` via the runner; a `path` source re-copies
 * from the recorded source location (which must still exist). Refreshes the manifest `version` +
 * `updatedAt`.
 */
export function updatePlugin(pluginsDir: string, name: string, opts: PluginUpdateOptions = {}): PluginUpdateResult {
  const runner = opts.runner ?? defaultRunner;
  const clock = opts.clock ?? (() => new Date().toISOString());
  const safe = validateName(name);
  const dir = join(pluginsDir, safe);
  if (!existsSync(dir)) throw new Error(`plugin "${safe}" is not installed`);
  const manifest = readManifest(dir);
  if (!manifest) {
    throw new Error(`plugin "${safe}" has no install manifest (${PLUGIN_MANIFEST}); it was not installed via 'mercury plugins install' and cannot be updated`);
  }

  let method: PluginUpdateResult['method'];
  if (manifest.source.type === 'git') {
    try {
      runner('git', ['-C', dir, 'pull', '--ff-only'], { cwd: dir });
    } catch (err) {
      throw new Error(`git pull failed for "${safe}": ${errorMessage(err)}`);
    }
    method = 'git-pull';
  } else {
    const from = manifest.source.location;
    if (!existsSync(from)) {
      throw new Error(`cannot update "${safe}": original source path is gone (${from})`);
    }
    if (manifest.source.singleFile) {
      cpSync(from, join(dir, `${safe}.js`));
    } else {
      // Refresh in place (overwrite files from the source dir; manifest is rewritten afterwards).
      cpSync(from, dir, { recursive: true });
    }
    method = 'recopy';
  }

  const version = dirVersion(dir);
  const updated: PluginManifest = { ...manifest, version, updatedAt: clock() };
  writeManifest(dir, updated);
  return { name: safe, dir, source: manifest.source, version, method };
}

/** The result of a successful {@link removePlugin}. */
export interface PluginRemoveResult {
  name: string;
  dir: string;
}

/**
 * Remove an installed plugin directory (`<pluginsDir>/<name>/`). This is destructive; the CLI gates it
 * behind `--force`/`--yes`. Throws if the plugin is not installed.
 */
export function removePlugin(pluginsDir: string, name: string): PluginRemoveResult {
  const safe = validateName(name);
  const dir = join(pluginsDir, safe);
  if (!existsSync(dir)) throw new Error(`plugin "${safe}" is not installed`);
  rmSync(dir, { recursive: true, force: true });
  return { name: safe, dir };
}

/**
 * List installed plugins under `pluginsDir` by reading each subdirectory's manifest + package.json. Does
 * not import or execute anything. Sorted by name for determinism.
 */
export function listInstalled(pluginsDir: string): InstalledPlugin[] {
  if (!existsSync(pluginsDir)) return [];
  const out: InstalledPlugin[] = [];
  for (const entry of readdirSync(pluginsDir)) {
    const dir = join(pluginsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const manifest = readManifest(dir);
    out.push({
      name: manifest?.name ?? entry,
      path: dir,
      version: manifest?.version ?? dirVersion(dir),
      source: manifest?.source,
      entryPresent: isPluginDir(dir),
      managed: !!manifest,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
