/**
 * Isolated-profile management for Mercury (Tier-2 gap #7).
 *
 * A *profile* is a named, fully isolated Mercury instance: its own **home directory** (`MERCURY_HOME`),
 * and therefore its own config, memory DB, skills, plugins, personalities, audit key — everything. This
 * is the home-level sibling of a *project* (Tier-2 #5): where a project scopes the **data dir** *within*
 * a home, a profile selects an entirely **separate home**. The layering is:
 *
 *   profile  → selects MERCURY_HOME        (this module)
 *     project → selects the data dir within that home   ({@link ../projects/manage.js})
 *
 * Profiles are "multiple isolated instances via `MERCURY_HOME` switching; mostly orchestration over the
 * existing home-dir indirection" — {@link ../config/load.js | mercuryHome()} already drives the home off
 * `MERCURY_HOME`, so this module just records which profile is active and resolves its home on the next
 * run, rather than inventing a parallel mechanism.
 *
 * ## The registry (control plane)
 * Because profiles sit ABOVE homes, their registry cannot live inside any one home. It is kept at
 * `~/.config/mercury/profiles.json` (override the directory with `MERCURY_PROFILES_DIR`). It records each
 * profile's name, home dir, optional description and timestamps, plus which profile is `active`.
 *
 * ## The default profile
 * A built-in profile named `default` always exists (even when the registry is empty) and maps to the
 * standard `~/.mercury`, so existing users are completely unaffected until they create a profile. It
 * cannot be created, renamed over, or removed.
 *
 * ## How selection applies
 * {@link resolveActiveProfileHome} reads the registry and returns the active profile's home. An explicit
 * `MERCURY_HOME` always wins (the resolver returns undefined so {@link ../config/load.js | mercuryHome()}
 * uses it); otherwise a `MERCURY_PROFILE` env var overrides the stored active profile. Because the
 * process cannot change its own parent environment, `mercury profile use` BOTH persists the selection
 * (so new processes pick it up) AND prints the exact `export MERCURY_PROFILE=<name>` line for the current
 * shell (like pyenv/direnv).
 *
 * Split into PURE functions (no fs — unit-testable with plain objects + injected clock/env) and a thin fs
 * layer (injected registry directory):
 *   - {@link validateProfileName}, {@link parseProfileRegistry}, {@link serializeProfileRegistry}              — shape
 *   - {@link findProfile}, {@link addProfile}, {@link removeProfileEntry}, {@link setProfileActive}      — pure CRUD
 *   - {@link resolveActiveProfileEntry}, {@link defaultProfile}, {@link defaultProfileHome}                   — selection
 *   - {@link readProfileRegistry}, {@link writeProfileRegistry}, {@link createProfile}, {@link useProfile},
 *     {@link removeProfile}, {@link listProfiles}, {@link showProfile}, {@link resolveActiveProfileHome}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Filename of the profile registry (kept in the profiles directory, above any home). */
export const PROFILE_REGISTRY_FILE = 'profiles.json';

/** Env var that overrides the stored active profile for a single run. */
export const PROFILE_ENV_VAR = 'MERCURY_PROFILE';

/** Env var that overrides the directory holding the profile registry. */
export const PROFILES_DIR_ENV_VAR = 'MERCURY_PROFILES_DIR';

/** The reserved, always-present profile name mapping to the standard `~/.mercury`. */
export const DEFAULT_PROFILE_NAME = 'default';

/** On-disk schema version of the registry. */
export const PROFILE_REGISTRY_VERSION = 1;

/** One named isolated instance. */
export interface Profile {
  name: string;
  /** Absolute home dir for this instance (its `MERCURY_HOME`). */
  home: string;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  /** True for the synthesized built-in `default` profile (never persisted, never removable). */
  builtin?: boolean;
}

/** The whole registry: the set of profiles plus which one is active. */
export interface ProfileRegistry {
  version: number;
  active?: string;
  profiles: Profile[];
}

/** One row of {@link listProfiles}: a profile plus derived runtime facts. */
export interface ProfileListEntry extends Profile {
  isActive: boolean;
  homeExists: boolean;
}

/** A clock injection (ISO string) so create/update timestamps are deterministic in tests. */
type Clock = () => string;

// ───────────────────────────────── pure layer (no fs) ─────────────────────────────────

/**
 * Validate a profile name: a safe single path segment — no separators, no `..` traversal, no leading
 * dot, only `[A-Za-z0-9._-]`, 1–64 chars. Returns the trimmed name on success; throws otherwise.
 */
export function validateProfileName(name: string): string {
  const n = (name ?? '').trim();
  if (!n) throw new Error('a profile name is required');
  if (n === '.' || n === '..' || n.startsWith('.')) throw new Error(`invalid profile name "${n}"`);
  if (n.includes('/') || n.includes('\\')) throw new Error(`invalid profile name "${n}" (no path separators)`);
  if (n.length > 64) throw new Error(`invalid profile name "${n}" (max 64 characters)`);
  if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`invalid profile name "${n}" (allowed: letters, digits, . _ -)`);
  return n;
}

/** The standard home dir for the built-in default profile (`~/.mercury`). */
export function defaultHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return join(homedir(), '.mercury');
}

/** The base directory under which non-default profile homes are created (`~/.mercury-profiles`). */
export function profilesHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MERCURY_PROFILES_HOME?.trim();
  return override ? resolve(override) : join(homedir(), '.mercury-profiles');
}

/**
 * The default home dir for a profile (pure): the standard `~/.mercury` for the `default` profile, else
 * `~/.mercury-profiles/<name>`.
 */
export function defaultProfileHome(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return name === DEFAULT_PROFILE_NAME ? defaultHomeRoot(env) : join(profilesHomeRoot(env), name);
}

/** The synthesized built-in default profile (never persisted). */
export function defaultProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  return { name: DEFAULT_PROFILE_NAME, home: defaultProfileHome(DEFAULT_PROFILE_NAME, env), createdAt: '', builtin: true };
}

/** An empty registry at the current schema version. */
export function emptyProfileRegistry(): ProfileRegistry {
  return { version: PROFILE_REGISTRY_VERSION, profiles: [] };
}

/** Coerce one unknown record into a normalized {@link Profile}, or undefined if unusable. */
function coerceProfile(raw: unknown): Profile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return undefined;
  const home = typeof r.home === 'string' && r.home ? r.home : '';
  if (!home) return undefined;
  return {
    name,
    home,
    description: typeof r.description === 'string' && r.description ? r.description : undefined,
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : undefined,
  };
}

/**
 * Parse arbitrary parsed-JSON into a normalized {@link ProfileRegistry} (pure, defensive). Malformed
 * entries are dropped, the reserved `default` name is never stored as an entry, names are de-duplicated
 * (first wins), and an `active` that names neither a known profile nor the always-valid `default` is
 * cleared — so a hand-edited or partly-corrupt file never crashes the CLI.
 */
export function parseProfileRegistry(raw: unknown): ProfileRegistry {
  if (typeof raw !== 'object' || raw === null) return emptyProfileRegistry();
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  const list = Array.isArray(r.profiles) ? r.profiles : [];
  for (const item of list) {
    const p = coerceProfile(item);
    if (!p || p.name === DEFAULT_PROFILE_NAME || seen.has(p.name)) continue;
    seen.add(p.name);
    profiles.push(p);
  }
  const activeRaw = typeof r.active === 'string' ? r.active : undefined;
  const active = activeRaw && (seen.has(activeRaw) || activeRaw === DEFAULT_PROFILE_NAME) ? activeRaw : undefined;
  const version = typeof r.version === 'number' ? r.version : PROFILE_REGISTRY_VERSION;
  return { version, active, profiles };
}

/** Serialize a registry deterministically (profiles sorted by name, stable key order). */
export function serializeProfileRegistry(reg: ProfileRegistry): string {
  const profiles = [...reg.profiles]
    .filter((p) => p.name !== DEFAULT_PROFILE_NAME)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({
      name: p.name,
      home: p.home,
      ...(p.description ? { description: p.description } : {}),
      createdAt: p.createdAt,
      ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
    }));
  return JSON.stringify({ version: PROFILE_REGISTRY_VERSION, ...(reg.active ? { active: reg.active } : {}), profiles }, null, 2);
}

/** Find a profile by exact name (pure). The reserved `default` resolves to the synthesized built-in. */
export function findProfile(reg: ProfileRegistry, name: string, env: NodeJS.ProcessEnv = process.env): Profile | undefined {
  if (name === DEFAULT_PROFILE_NAME) return defaultProfile(env);
  return reg.profiles.find((p) => p.name === name);
}

/** Add a profile, returning a NEW registry. Throws if a profile of that name already exists. */
export function addProfile(reg: ProfileRegistry, profile: Profile): ProfileRegistry {
  if (profile.name === DEFAULT_PROFILE_NAME) throw new Error(`"${DEFAULT_PROFILE_NAME}" is a reserved profile name`);
  if (reg.profiles.some((p) => p.name === profile.name)) throw new Error(`profile "${profile.name}" already exists`);
  return { ...reg, profiles: [...reg.profiles, profile] };
}

/**
 * Remove a profile by name, returning a NEW registry. Clears `active` if the removed profile was active.
 * Throws for the reserved `default` or an unknown profile.
 */
export function removeProfileEntry(reg: ProfileRegistry, name: string): ProfileRegistry {
  if (name === DEFAULT_PROFILE_NAME) throw new Error(`the "${DEFAULT_PROFILE_NAME}" profile cannot be removed`);
  if (!reg.profiles.some((p) => p.name === name)) throw new Error(`profile "${name}" does not exist`);
  const profiles = reg.profiles.filter((p) => p.name !== name);
  const active = reg.active === name ? undefined : reg.active;
  return { ...reg, profiles, active };
}

/** Set the active profile, returning a NEW registry. `default` is always valid; others must exist. */
export function setProfileActive(reg: ProfileRegistry, name: string): ProfileRegistry {
  if (name !== DEFAULT_PROFILE_NAME && !reg.profiles.some((p) => p.name === name)) {
    throw new Error(`profile "${name}" does not exist`);
  }
  return { ...reg, active: name };
}

/**
 * Resolve the active profile (pure). An explicit `MERCURY_PROFILE` env value wins over the stored active
 * profile (and must name a known profile or `default`, else undefined). Returns the resolved profile, or
 * undefined when nothing is selected (meaning the implicit default instance).
 */
export function resolveActiveProfileEntry(reg: ProfileRegistry, env: NodeJS.ProcessEnv = process.env): Profile | undefined {
  const override = env[PROFILE_ENV_VAR]?.trim();
  const name = override || reg.active;
  return name ? findProfile(reg, name, env) : undefined;
}

// ───────────────────────────────── fs layer (thin) ─────────────────────────────────

/** The directory holding the profile registry (`MERCURY_PROFILES_DIR` override, else `~/.config/mercury`). */
export function profileRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PROFILES_DIR_ENV_VAR]?.trim();
  return override ? resolve(override) : join(homedir(), '.config', 'mercury');
}

/** Absolute path of the registry file inside a profiles directory. */
export function profileRegistryPath(dir: string): string {
  return join(dir, PROFILE_REGISTRY_FILE);
}

/** Read + parse the registry from a profiles directory (empty registry when absent/corrupt). */
export function readProfileRegistry(dir: string): ProfileRegistry {
  const file = profileRegistryPath(dir);
  if (!existsSync(file)) return emptyProfileRegistry();
  try {
    return parseProfileRegistry(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyProfileRegistry();
  }
}

/** Write a registry to a profiles directory (deterministic serialization). */
export function writeProfileRegistry(dir: string, reg: ProfileRegistry): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(profileRegistryPath(dir), serializeProfileRegistry(reg));
}

/** Options for {@link createProfile}. */
export interface CreateProfileOptions {
  /** Explicit home dir (absolute, or resolved relative to cwd). Defaults to `~/.mercury-profiles/<name>`. */
  home?: string;
  description?: string;
  /** Make the new profile active immediately. */
  use?: boolean;
  clock?: Clock;
  /** Environment used to derive default home locations (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Create a new named profile: validates the name, ensures it does not already exist (and is not the
 * reserved `default`), creates its home dir, appends it to the registry and persists. Optionally makes
 * it active.
 */
export function createProfile(dir: string, name: string, opts: CreateProfileOptions = {}): Profile {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const env = opts.env ?? process.env;
  const safe = validateProfileName(name);
  if (safe === DEFAULT_PROFILE_NAME) throw new Error(`"${DEFAULT_PROFILE_NAME}" is a reserved profile name`);
  const reg = readProfileRegistry(dir);
  if (findProfile(reg, safe, env) && reg.profiles.some((p) => p.name === safe)) {
    throw new Error(`profile "${safe}" already exists`);
  }

  const home = opts.home ? resolve(opts.home) : defaultProfileHome(safe, env);
  mkdirSync(home, { recursive: true });

  const profile: Profile = {
    name: safe,
    home,
    description: opts.description?.trim() || undefined,
    createdAt: clock(),
  };
  let next = addProfile(reg, profile);
  if (opts.use) next = setProfileActive(next, safe);
  writeProfileRegistry(dir, next);
  return profile;
}

/** Switch the active profile. Returns the now-active profile. `default` is always valid. */
export function useProfile(dir: string, name: string, env: NodeJS.ProcessEnv = process.env): Profile {
  const safe = validateProfileName(name);
  const reg = readProfileRegistry(dir);
  const next = setProfileActive(reg, safe);
  writeProfileRegistry(dir, next);
  return findProfile(next, safe, env)!;
}

/** Clear the active profile (fall back to the implicit default). Returns the updated registry. */
export function clearProfileActive(dir: string): ProfileRegistry {
  const reg = readProfileRegistry(dir);
  const next = { ...reg, active: undefined };
  writeProfileRegistry(dir, next);
  return next;
}

/** The result of {@link removeProfile}. */
export interface RemoveProfileResult {
  name: string;
  home: string;
  /** Whether the home dir on disk was also deleted (`purge`). */
  purged: boolean;
  /** Whether the removed profile had been the active one. */
  wasActive: boolean;
}

/** Options for {@link removeProfile}. */
export interface RemoveProfileOptions {
  /** Also delete the profile's home dir from disk (extra-destructive; default just unregisters). */
  purge?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Remove a profile from the registry. By default this only *unregisters* it (the home dir is left on
 * disk); pass `purge` to also delete the home dir. Refuses the reserved `default`, and never purges the
 * standard `~/.mercury` as a safety net. The CLI gates this behind `--force`/`--yes`.
 */
export function removeProfile(dir: string, name: string, opts: RemoveProfileOptions = {}): RemoveProfileResult {
  const env = opts.env ?? process.env;
  const safe = validateProfileName(name);
  if (safe === DEFAULT_PROFILE_NAME) throw new Error(`the "${DEFAULT_PROFILE_NAME}" profile cannot be removed`);
  const reg = readProfileRegistry(dir);
  const profile = reg.profiles.find((p) => p.name === safe);
  if (!profile) throw new Error(`profile "${safe}" does not exist`);
  const wasActive = reg.active === safe;
  const next = removeProfileEntry(reg, safe);
  writeProfileRegistry(dir, next);
  let purged = false;
  if (opts.purge && existsSync(profile.home) && resolve(profile.home) !== resolve(defaultHomeRoot(env))) {
    rmSync(profile.home, { recursive: true, force: true });
    purged = true;
  }
  return { name: safe, home: profile.home, purged, wasActive };
}

/**
 * List all profiles (the built-in `default` always first, then registered ones sorted by name), with
 * active + home-existence flags.
 */
export function listProfiles(dir: string, env: NodeJS.ProcessEnv = process.env): ProfileListEntry[] {
  const reg = readProfileRegistry(dir);
  const active = resolveActiveProfileEntry(reg, env)?.name;
  // The built-in default is the effective running instance whenever nothing else is selected.
  const defaultActive = active === DEFAULT_PROFILE_NAME || !active;
  const rows: ProfileListEntry[] = [
    { ...defaultProfile(env), isActive: defaultActive, homeExists: safeIsDir(defaultProfileHome(DEFAULT_PROFILE_NAME, env)) },
  ];
  for (const p of [...reg.profiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    rows.push({ ...p, isActive: active === p.name, homeExists: safeIsDir(p.home) });
  }
  return rows;
}

/**
 * Show one profile's details. With no name, shows the currently active profile (the built-in `default`
 * when none is selected, since that is the effective running instance). Throws if an explicit name is
 * unknown.
 */
export function showProfile(dir: string, name?: string, env: NodeJS.ProcessEnv = process.env): ProfileListEntry {
  const reg = readProfileRegistry(dir);
  const activeName = resolveActiveProfileEntry(reg, env)?.name;
  const target = name ? validateProfileName(name) : activeName ?? DEFAULT_PROFILE_NAME;
  const p = findProfile(reg, target, env);
  if (!p) throw new Error(`profile "${target}" does not exist`);
  return { ...p, isActive: activeName === p.name || (!activeName && p.name === DEFAULT_PROFILE_NAME), homeExists: safeIsDir(p.home) };
}

/**
 * Resolve the active profile's HOME for {@link ../config/load.js | mercuryHome()}. An explicit
 * `MERCURY_HOME` always wins (returns undefined so the caller uses it). Otherwise consults the registry,
 * honoring the `MERCURY_PROFILE` override. Returns undefined when nothing is selected (implicit default).
 * Never throws — a corrupt/absent registry resolves to undefined so the standard home is used.
 */
export function resolveActiveProfileHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MERCURY_HOME && env.MERCURY_HOME.trim()) return undefined;
  try {
    const reg = readProfileRegistry(profileRegistryDir(env));
    return resolveActiveProfileEntry(reg, env)?.home;
  } catch {
    return undefined;
  }
}

/** The name of the active profile (honoring the env override), or the built-in `default`. */
export function activeProfileName(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveActiveProfileEntry(readProfileRegistry(dir), env)?.name ?? DEFAULT_PROFILE_NAME;
}

/** True when `dir` exists and is a directory (never throws). */
function safeIsDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** How many top-level entries a profile's home dir currently holds (0 when absent); honest "is it used". */
export function profileHomeEntryCount(dir: string): number {
  try {
    return safeIsDir(dir) ? readdirSync(dir).length : 0;
  } catch {
    return 0;
  }
}
