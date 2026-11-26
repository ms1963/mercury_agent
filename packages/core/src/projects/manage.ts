/**
 * Project / workspace management for Mercury (Tier-2 gap #5).
 *
 * A *project* is a named workspace that scopes Mercury's entire per-instance state — config, the SQLite
 * memory DB, skills, plugins, personalities, the workspace jail — so different projects never share
 * state. This is built on top of the EXISTING data-dir indirection ({@link ../config/load.js}): the
 * runtime already hangs everything off `config.dataDir`, so pointing `dataDir` at a project's own folder
 * scopes config AND memory in one move, rather than inventing a parallel mechanism.
 *
 * ## The registry (control plane)
 * Projects are tracked in a single registry file, `projects.json`, kept in the Mercury **home**
 * (`~/.mercury`, i.e. {@link ../config/load.js | mercuryHome()}) — NOT inside any project's data dir,
 * because project switching must live *above* the scoped data dirs. The registry records each project's
 * name, data dir, optional folders + description and timestamps, plus which project is `active`.
 *
 * ## How selection applies
 * {@link resolveActiveProjectDataDir} reads the registry and returns the active project's data dir (an
 * explicit `MERCURY_PROJECT` env var overrides the stored active project). `loadConfig` consults it only
 * when no data dir was set explicitly (no `dataDir` in config and no `MERCURY_DATA_DIR`), so env/flags
 * always win and isolated test instances are never affected.
 *
 * The module is split into PURE functions (no fs — fully unit-testable with plain objects + an injected
 * clock) and a thin fs layer:
 *   - {@link validateProjectName}, {@link parseRegistry}, {@link serializeRegistry}            — shape
 *   - {@link findProject}, {@link addProject}, {@link removeProjectEntry}, {@link setActive}    — pure CRUD
 *   - {@link resolveActive}, {@link defaultProjectDataDir}                                      — selection
 *   - {@link readRegistry}, {@link writeRegistry}, {@link createProject}, {@link useProject},
 *     {@link removeProject}, {@link listProjects}, {@link showProject}                          — fs layer
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Filename of the project registry, kept in the Mercury home directory. */
export const PROJECT_REGISTRY_FILE = 'projects.json';

/** Env var that overrides the stored active project for a single run. */
export const PROJECT_ENV_VAR = 'MERCURY_PROJECT';

/** On-disk schema version of the registry. */
export const PROJECT_REGISTRY_VERSION = 1;

/** One named workspace. */
export interface Project {
  name: string;
  /** Absolute data dir that scopes this project's config + memory (`<home>/projects/<name>` by default). */
  dataDir: string;
  /** Optional extra working folders associated with the project (absolute paths). */
  folders: string[];
  description?: string;
  createdAt: string;
  updatedAt?: string;
}

/** The whole registry: the set of projects plus which one is active. */
export interface ProjectRegistry {
  version: number;
  active?: string;
  projects: Project[];
}

/** One row of {@link listProjects}: a project plus derived runtime facts. */
export interface ProjectListEntry extends Project {
  isActive: boolean;
  dataDirExists: boolean;
}

/** A clock injection (ISO string) so create/update timestamps are deterministic in tests. */
type Clock = () => string;

// ───────────────────────────────── pure layer (no fs) ─────────────────────────────────

/**
 * Validate a project name: it must be a safe single path segment — no separators, no `..` traversal, no
 * leading dot, only `[A-Za-z0-9._-]`, 1–64 chars. Returns the trimmed name on success; throws otherwise.
 */
export function validateProjectName(name: string): string {
  const n = (name ?? '').trim();
  if (!n) throw new Error('a project name is required');
  if (n === '.' || n === '..' || n.startsWith('.')) throw new Error(`invalid project name "${n}"`);
  if (n.includes('/') || n.includes('\\')) throw new Error(`invalid project name "${n}" (no path separators)`);
  if (n.length > 64) throw new Error(`invalid project name "${n}" (max 64 characters)`);
  if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`invalid project name "${n}" (allowed: letters, digits, . _ -)`);
  return n;
}

/** An empty registry at the current schema version. */
export function emptyRegistry(): ProjectRegistry {
  return { version: PROJECT_REGISTRY_VERSION, projects: [] };
}

/** Coerce one unknown record into a normalized {@link Project}, or undefined if it is unusable. */
function coerceProject(raw: unknown): Project | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return undefined;
  const dataDir = typeof r.dataDir === 'string' && r.dataDir ? r.dataDir : '';
  if (!dataDir) return undefined;
  const folders = Array.isArray(r.folders) ? r.folders.filter((f): f is string => typeof f === 'string' && !!f) : [];
  return {
    name,
    dataDir,
    folders,
    description: typeof r.description === 'string' && r.description ? r.description : undefined,
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : undefined,
  };
}

/**
 * Parse arbitrary parsed-JSON into a normalized {@link ProjectRegistry} (pure, defensive). Malformed
 * entries are dropped, names are de-duplicated (first wins), and an `active` that no longer names a known
 * project is cleared, so a hand-edited or partially-corrupt file never crashes the CLI.
 */
export function parseRegistry(raw: unknown): ProjectRegistry {
  if (typeof raw !== 'object' || raw === null) return emptyRegistry();
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const projects: Project[] = [];
  const list = Array.isArray(r.projects) ? r.projects : [];
  for (const item of list) {
    const p = coerceProject(item);
    if (!p || seen.has(p.name)) continue;
    seen.add(p.name);
    projects.push(p);
  }
  const active = typeof r.active === 'string' && seen.has(r.active) ? r.active : undefined;
  const version = typeof r.version === 'number' ? r.version : PROJECT_REGISTRY_VERSION;
  return { version, active, projects };
}

/** Serialize a registry deterministically (projects sorted by name, stable key order). */
export function serializeRegistry(reg: ProjectRegistry): string {
  const projects = [...reg.projects]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({
      name: p.name,
      dataDir: p.dataDir,
      folders: p.folders,
      ...(p.description ? { description: p.description } : {}),
      createdAt: p.createdAt,
      ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
    }));
  return JSON.stringify({ version: PROJECT_REGISTRY_VERSION, ...(reg.active ? { active: reg.active } : {}), projects }, null, 2);
}

/** Find a project by exact name (pure). */
export function findProject(reg: ProjectRegistry, name: string): Project | undefined {
  return reg.projects.find((p) => p.name === name);
}

/** Add a project, returning a NEW registry. Throws if a project of that name already exists. */
export function addProject(reg: ProjectRegistry, project: Project): ProjectRegistry {
  if (findProject(reg, project.name)) throw new Error(`project "${project.name}" already exists`);
  return { ...reg, projects: [...reg.projects, project] };
}

/**
 * Remove a project by name, returning a NEW registry. Clears `active` if the removed project was active.
 * Throws if the project is unknown.
 */
export function removeProjectEntry(reg: ProjectRegistry, name: string): ProjectRegistry {
  if (!findProject(reg, name)) throw new Error(`project "${name}" does not exist`);
  const projects = reg.projects.filter((p) => p.name !== name);
  const active = reg.active === name ? undefined : reg.active;
  return { ...reg, projects, active };
}

/** Set the active project, returning a NEW registry. Throws if the project is unknown. */
export function setActive(reg: ProjectRegistry, name: string): ProjectRegistry {
  if (!findProject(reg, name)) throw new Error(`project "${name}" does not exist`);
  return { ...reg, active: name };
}

/**
 * Resolve the active project (pure). An explicit `MERCURY_PROJECT` env value wins over the stored active
 * project (and must still name a known project, else undefined). Returns the resolved project or undefined.
 */
export function resolveActive(reg: ProjectRegistry, env: NodeJS.ProcessEnv = process.env): Project | undefined {
  const override = env[PROJECT_ENV_VAR]?.trim();
  const name = override || reg.active;
  return name ? findProject(reg, name) : undefined;
}

/** The default data dir for a project: `<home>/projects/<name>`. */
export function defaultProjectDataDir(home: string, name: string): string {
  return join(home, 'projects', name);
}

// ───────────────────────────────── fs layer (thin) ─────────────────────────────────

/** Absolute path of the registry file inside the Mercury home. */
export function registryPath(home: string): string {
  return join(home, PROJECT_REGISTRY_FILE);
}

/** Read + parse the registry for a home directory (returns an empty registry when absent/corrupt). */
export function readRegistry(home: string): ProjectRegistry {
  const file = registryPath(home);
  if (!existsSync(file)) return emptyRegistry();
  try {
    return parseRegistry(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyRegistry();
  }
}

/** Write a registry to a home directory (deterministic serialization). */
export function writeRegistry(home: string, reg: ProjectRegistry): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(registryPath(home), serializeRegistry(reg));
}

/** Options for {@link createProject}. */
export interface CreateProjectOptions {
  /** Explicit data dir (absolute, or resolved relative to cwd). Defaults to `<home>/projects/<name>`. */
  dataDir?: string;
  /** Extra working folders to associate (resolved to absolute paths; created if missing). */
  folders?: string[];
  description?: string;
  /** Make the new project active immediately. */
  use?: boolean;
  clock?: Clock;
}

/**
 * Create a new named project under `home`: validates the name, ensures it does not already exist, creates
 * its data dir (and any folders), appends it to the registry and persists. Optionally makes it active.
 */
export function createProject(home: string, name: string, opts: CreateProjectOptions = {}): Project {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const safe = validateProjectName(name);
  const reg = readRegistry(home);
  if (findProject(reg, safe)) throw new Error(`project "${safe}" already exists`);

  const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultProjectDataDir(home, safe);
  const folders = (opts.folders ?? []).map((f) => (isAbsolute(f) ? f : resolve(f)));
  mkdirSync(dataDir, { recursive: true });
  for (const f of folders) mkdirSync(f, { recursive: true });

  const project: Project = {
    name: safe,
    dataDir,
    folders,
    description: opts.description?.trim() || undefined,
    createdAt: clock(),
  };
  let next = addProject(reg, project);
  if (opts.use) next = setActive(next, safe);
  writeRegistry(home, next);
  return project;
}

/** Switch the active project. Returns the now-active project. Throws if unknown. */
export function useProject(home: string, name: string): Project {
  const safe = validateProjectName(name);
  const reg = readRegistry(home);
  const next = setActive(reg, safe);
  writeRegistry(home, next);
  return findProject(next, safe)!;
}

/** Clear the active project (no project selected). Returns the updated registry. */
export function clearActive(home: string): ProjectRegistry {
  const reg = readRegistry(home);
  const next = { ...reg, active: undefined };
  writeRegistry(home, next);
  return next;
}

/** The result of {@link removeProject}. */
export interface RemoveProjectResult {
  name: string;
  dataDir: string;
  /** Whether the data dir on disk was also deleted (`purge`). */
  purged: boolean;
  /** Whether the removed project had been the active one. */
  wasActive: boolean;
}

/** Options for {@link removeProject}. */
export interface RemoveProjectOptions {
  /** Also delete the project's data dir from disk (extra-destructive; default just unregisters). */
  purge?: boolean;
}

/**
 * Remove a project from the registry. By default this only *unregisters* it (the data dir is left on
 * disk); pass `purge` to also delete the data dir. The CLI gates this behind `--force`/`--yes`.
 */
export function removeProject(home: string, name: string, opts: RemoveProjectOptions = {}): RemoveProjectResult {
  const safe = validateProjectName(name);
  const reg = readRegistry(home);
  const project = findProject(reg, safe);
  if (!project) throw new Error(`project "${safe}" does not exist`);
  const wasActive = reg.active === safe;
  const next = removeProjectEntry(reg, safe);
  writeRegistry(home, next);
  let purged = false;
  if (opts.purge && existsSync(project.dataDir)) {
    rmSync(project.dataDir, { recursive: true, force: true });
    purged = true;
  }
  return { name: safe, dataDir: project.dataDir, purged, wasActive };
}

/** List all projects under `home`, newest-neutral (sorted by name), with active + existence flags. */
export function listProjects(home: string): ProjectListEntry[] {
  const reg = readRegistry(home);
  return [...reg.projects]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({ ...p, isActive: reg.active === p.name, dataDirExists: safeIsDir(p.dataDir) }));
}

/**
 * Show one project's details. With no name, shows the active project (undefined if none is active).
 * Throws if an explicit name is unknown.
 */
export function showProject(home: string, name?: string): ProjectListEntry | undefined {
  const reg = readRegistry(home);
  const target = name ? validateProjectName(name) : reg.active;
  if (!target) return undefined;
  const p = findProject(reg, target);
  if (!p) throw new Error(`project "${target}" does not exist`);
  return { ...p, isActive: reg.active === p.name, dataDirExists: safeIsDir(p.dataDir) };
}

/**
 * Resolve the active project's data dir for a home directory, honoring the `MERCURY_PROJECT` env
 * override. Returns undefined when no project is active (or the env override names an unknown project).
 * Consumed by `loadConfig` to scope config + memory to the active project.
 */
export function resolveActiveProjectDataDir(home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const active = resolveActive(readRegistry(home), env);
  return active?.dataDir;
}

/** The name of the active project for a home (honoring the env override), or undefined. */
export function activeProjectName(home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveActive(readRegistry(home), env)?.name;
}

/** True when `dir` exists and is a directory (never throws). */
function safeIsDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** How many top-level entries a project's data dir currently holds (0 when absent); honest "is it used". */
export function projectDataDirEntryCount(dir: string): number {
  try {
    return safeIsDir(dir) ? readdirSync(dir).length : 0;
  } catch {
    return 0;
  }
}
