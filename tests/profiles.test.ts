/**
 * Tests for the isolated-profile surface (`mercury profile ...`), i.e. the core module
 * packages/core/src/profiles/manage.ts.
 *
 * SCOPE: fully offline and deterministic. The PURE registry logic (validate / parse / serialize / CRUD /
 * active resolution) is exercised with plain objects and an injected env; the fs layer (create / use /
 * remove / list / show / resolveActiveProfileHome) runs against real temp directories (mkdtempSync +
 * afterEach rmSync), with an injected clock so timestamps are deterministic and an injected env so no
 * real `~/.mercury`, `~/.mercury-profiles` or `~/.config/mercury` is ever touched.
 *
 * Profiles sit ABOVE homes: a profile selects MERCURY_HOME; (within it) a project selects the data dir.
 * The built-in `default` profile maps to the standard ~/.mercury and is protected from create/remove.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateProfileName,
  emptyProfileRegistry,
  parseProfileRegistry,
  serializeProfileRegistry,
  findProfile,
  addProfile,
  removeProfileEntry,
  setProfileActive,
  resolveActiveProfileEntry,
  defaultProfile,
  defaultProfileHome,
  defaultHomeRoot,
  profilesHomeRoot,
  createProfile,
  useProfile,
  clearProfileActive,
  removeProfile,
  listProfiles,
  showProfile,
  readProfileRegistry,
  writeProfileRegistry,
  resolveActiveProfileHome,
  activeProfileName,
  profileHomeEntryCount,
  profileRegistryPath,
  profileRegistryDir,
  PROFILE_ENV_VAR,
  PROFILES_DIR_ENV_VAR,
  PROFILE_REGISTRY_FILE,
  DEFAULT_PROFILE_NAME,
  type Profile,
  type ProfileRegistry,
} from '@mercury/core';

// ──────────────────────────── temp-dir harness ────────────────────────────

const tmpDirs: string[] = [];
function mktmp(prefix = 'merc-profiles-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const CLOCK = () => '2024-01-01T00:00:00.000Z';

/**
 * A registry-dir + an env that keeps non-default profile homes inside a temp tree (MERCURY_PROFILES_HOME)
 * and points the registry at the temp dir (MERCURY_PROFILES_DIR) for the env-driven resolvers.
 */
function harness(extra: NodeJS.ProcessEnv = {}): { dir: string; homeRoot: string; env: NodeJS.ProcessEnv } {
  const dir = mktmp('merc-prof-reg-');
  const homeRoot = mktmp('merc-prof-homes-');
  const env: NodeJS.ProcessEnv = { MERCURY_PROFILES_HOME: homeRoot, [PROFILES_DIR_ENV_VAR]: dir, ...extra };
  return { dir, homeRoot, env };
}

/** A plain profile fixture (pure tests). */
function prof(name: string, over: Partial<Profile> = {}): Profile {
  return { name, home: `/homes/${name}`, createdAt: '2024-01-01T00:00:00.000Z', ...over };
}

// ──────────────────────────── pure: validateProfileName ────────────────────────────

describe('validateProfileName', () => {
  it('accepts safe names and trims', () => {
    expect(validateProfileName('  work_1.2-x ')).toBe('work_1.2-x');
  });
  it('rejects traversal, separators, leading dots, bad chars, too-long, empty', () => {
    expect(() => validateProfileName('')).toThrow();
    expect(() => validateProfileName('..')).toThrow();
    expect(() => validateProfileName('.hidden')).toThrow();
    expect(() => validateProfileName('a/b')).toThrow();
    expect(() => validateProfileName('a\\b')).toThrow();
    expect(() => validateProfileName('bad name!')).toThrow();
    expect(() => validateProfileName('x'.repeat(65))).toThrow();
  });
});

// ──────────────────────────── pure: home-path resolution ────────────────────────────

describe('defaultProfileHome / defaultProfile', () => {
  it('maps the default profile to the standard ~/.mercury', () => {
    expect(defaultProfileHome(DEFAULT_PROFILE_NAME, {})).toBe(defaultHomeRoot({}));
    expect(defaultProfile({}).builtin).toBe(true);
    expect(defaultProfile({}).name).toBe(DEFAULT_PROFILE_NAME);
  });
  it('maps a named profile under the profiles home root', () => {
    const env = { MERCURY_PROFILES_HOME: '/tmp/ph' };
    expect(profilesHomeRoot(env)).toBe('/tmp/ph');
    expect(defaultProfileHome('alpha', env)).toBe(join('/tmp/ph', 'alpha'));
  });
});

// ──────────────────────────── pure: parse / serialize ────────────────────────────

describe('parseProfileRegistry', () => {
  it('returns an empty registry for junk', () => {
    expect(parseProfileRegistry(null).profiles).toEqual([]);
    expect(parseProfileRegistry(42).profiles).toEqual([]);
    expect(parseProfileRegistry('nope').profiles).toEqual([]);
  });
  it('drops malformed/default entries and de-duplicates by name (first wins)', () => {
    const reg = parseProfileRegistry({
      profiles: [
        { name: 'a', home: '/h/a', createdAt: 't' },
        { name: 'a', home: '/h/a2', createdAt: 't' }, // dup → dropped
        { name: 'default', home: '/h/x', createdAt: 't' }, // reserved → dropped
        { name: 'b' }, // no home → dropped
        { home: '/h/x' }, // no name → dropped
        'garbage',
      ],
    });
    expect(reg.profiles.map((p) => p.name)).toEqual(['a']);
    expect(reg.profiles[0]!.home).toBe('/h/a');
  });
  it('clears an active that names no known profile', () => {
    const reg = parseProfileRegistry({ active: 'ghost', profiles: [{ name: 'a', home: '/h/a', createdAt: 't' }] });
    expect(reg.active).toBeUndefined();
  });
  it('keeps a valid active, and always accepts the reserved default as active', () => {
    expect(parseProfileRegistry({ active: 'a', profiles: [{ name: 'a', home: '/h/a', createdAt: 't' }] }).active).toBe('a');
    expect(parseProfileRegistry({ active: 'default', profiles: [] }).active).toBe('default');
  });
});

describe('serializeProfileRegistry', () => {
  it('sorts profiles by name, never persists default, and round-trips through parse', () => {
    const reg: ProfileRegistry = {
      version: 1,
      active: 'b',
      profiles: [prof('b'), prof('a'), prof('default', { builtin: true })],
    };
    const text = serializeProfileRegistry(reg);
    expect(text.indexOf('"name": "a"')).toBeLessThan(text.indexOf('"name": "b"'));
    expect(text).not.toContain('"default"');
    const back = parseProfileRegistry(JSON.parse(text));
    expect(back.profiles.map((p) => p.name)).toEqual(['a', 'b']);
    expect(back.active).toBe('b');
  });
  it('omits active when none is set', () => {
    const text = serializeProfileRegistry({ version: 1, profiles: [prof('a')] });
    expect(text).not.toContain('"active"');
  });
});

// ──────────────────────────── pure: CRUD + selection ────────────────────────────

describe('pure registry CRUD', () => {
  it('addProfile appends, refuses duplicates and the reserved default', () => {
    const reg = addProfile(emptyProfileRegistry(), prof('a'));
    expect(reg.profiles.map((p) => p.name)).toEqual(['a']);
    expect(() => addProfile(reg, prof('a'))).toThrow(/already exists/);
    expect(() => addProfile(reg, prof('default'))).toThrow(/reserved/);
  });
  it('removeProfileEntry removes, clears active when it was active, refuses default', () => {
    let reg = addProfile(addProfile(emptyProfileRegistry(), prof('a')), prof('b'));
    reg = setProfileActive(reg, 'a');
    reg = removeProfileEntry(reg, 'a');
    expect(reg.profiles.map((p) => p.name)).toEqual(['b']);
    expect(reg.active).toBeUndefined();
    expect(() => removeProfileEntry(reg, 'default')).toThrow(/cannot be removed/);
  });
  it('removeProfileEntry keeps active when a different profile is removed', () => {
    let reg = addProfile(addProfile(emptyProfileRegistry(), prof('a')), prof('b'));
    reg = setProfileActive(reg, 'a');
    reg = removeProfileEntry(reg, 'b');
    expect(reg.active).toBe('a');
  });
  it('removeProfileEntry and setProfileActive throw on unknown names', () => {
    expect(() => removeProfileEntry(emptyProfileRegistry(), 'x')).toThrow(/does not exist/);
    expect(() => setProfileActive(emptyProfileRegistry(), 'x')).toThrow(/does not exist/);
  });
  it('setProfileActive always accepts the reserved default', () => {
    expect(setProfileActive(emptyProfileRegistry(), 'default').active).toBe('default');
  });
  it('findProfile resolves by exact name and synthesizes default', () => {
    const reg = addProfile(emptyProfileRegistry(), prof('a'));
    expect(findProfile(reg, 'a')?.name).toBe('a');
    expect(findProfile(reg, 'z')).toBeUndefined();
    expect(findProfile(reg, 'default', {})?.builtin).toBe(true);
  });
});

describe('resolveActiveProfileEntry', () => {
  const reg = setProfileActive(addProfile(addProfile(emptyProfileRegistry(), prof('a')), prof('b')), 'a');
  it('returns the stored active profile', () => {
    expect(resolveActiveProfileEntry(reg, {})?.name).toBe('a');
  });
  it('lets MERCURY_PROFILE override the stored active', () => {
    expect(resolveActiveProfileEntry(reg, { [PROFILE_ENV_VAR]: 'b' })?.name).toBe('b');
  });
  it('resolves the default override to the synthesized built-in', () => {
    expect(resolveActiveProfileEntry(reg, { [PROFILE_ENV_VAR]: 'default' })?.builtin).toBe(true);
  });
  it('returns undefined when the env override names an unknown profile', () => {
    expect(resolveActiveProfileEntry(reg, { [PROFILE_ENV_VAR]: 'ghost' })).toBeUndefined();
  });
  it('returns undefined when none is active and no override', () => {
    expect(resolveActiveProfileEntry(emptyProfileRegistry(), {})).toBeUndefined();
  });
});

// ──────────────────────────── fs: create / use / list / show ────────────────────────────

describe('createProfile', () => {
  it('creates the home dir, writes the registry and derives the default home', () => {
    const { dir, env } = harness();
    const p = createProfile(dir, 'alpha', { clock: CLOCK, env });
    expect(p.home).toBe(defaultProfileHome('alpha', env));
    expect(existsSync(p.home)).toBe(true);
    expect(p.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(existsSync(profileRegistryPath(dir))).toBe(true);
    expect(profileRegistryPath(dir).endsWith(PROFILE_REGISTRY_FILE)).toBe(true);
    const reg = readProfileRegistry(dir);
    expect(reg.profiles.map((x) => x.name)).toEqual(['alpha']);
    expect(reg.active).toBeUndefined(); // not active unless --use
  });

  it('honours an explicit home, description and --use', () => {
    const { dir, env } = harness();
    const home = join(mktmp('merc-custom-home-'), 'nest');
    const p = createProfile(dir, 'beta', { home, description: 'my beta', use: true, clock: CLOCK, env });
    expect(p.home).toBe(home);
    expect(existsSync(home)).toBe(true);
    expect(p.description).toBe('my beta');
    expect(readProfileRegistry(dir).active).toBe('beta');
  });

  it('refuses a duplicate name and the reserved default', () => {
    const { dir, env } = harness();
    createProfile(dir, 'dup', { clock: CLOCK, env });
    expect(() => createProfile(dir, 'dup', { clock: CLOCK, env })).toThrow(/already exists/);
    expect(() => createProfile(dir, 'default', { clock: CLOCK, env })).toThrow(/reserved/);
  });

  it('rejects an invalid name before touching disk', () => {
    const { dir, env } = harness();
    expect(() => createProfile(dir, '../escape', { clock: CLOCK, env })).toThrow();
    expect(existsSync(profileRegistryPath(dir))).toBe(false);
  });
});

describe('useProfile / clearProfileActive / activeProfileName', () => {
  it('switches the active profile and reports it; defaults to "default"', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { clock: CLOCK, env });
    createProfile(dir, 'b', { clock: CLOCK, env });
    expect(activeProfileName(dir, env)).toBe(DEFAULT_PROFILE_NAME);
    useProfile(dir, 'b', env);
    expect(activeProfileName(dir, env)).toBe('b');
    useProfile(dir, 'a', env);
    expect(activeProfileName(dir, env)).toBe('a');
    clearProfileActive(dir);
    expect(activeProfileName(dir, env)).toBe(DEFAULT_PROFILE_NAME);
  });
  it('can switch back to the built-in default', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { use: true, clock: CLOCK, env });
    expect(useProfile(dir, 'default', env).builtin).toBe(true);
    expect(readProfileRegistry(dir).active).toBe('default');
  });
  it('useProfile throws for an unknown profile', () => {
    const { dir, env } = harness();
    expect(() => useProfile(dir, 'ghost', env)).toThrow(/does not exist/);
  });
});

describe('listProfiles', () => {
  it('always lists default first, then registered sorted, with active + existence flags', () => {
    const { dir, env } = harness();
    createProfile(dir, 'zeta', { clock: CLOCK, env });
    createProfile(dir, 'alpha', { use: true, clock: CLOCK, env });
    const list = listProfiles(dir, env);
    expect(list.map((p) => p.name)).toEqual([DEFAULT_PROFILE_NAME, 'alpha', 'zeta']);
    expect(list.find((p) => p.name === 'alpha')!.isActive).toBe(true);
    expect(list.find((p) => p.name === 'zeta')!.isActive).toBe(false);
    expect(list.find((p) => p.name === DEFAULT_PROFILE_NAME)!.isActive).toBe(false);
    expect(list.find((p) => p.name === 'alpha')!.homeExists).toBe(true);
  });
  it('for a fresh registry lists only the built-in default (marked active)', () => {
    const { dir, env } = harness();
    const list = listProfiles(dir, env);
    expect(list.map((p) => p.name)).toEqual([DEFAULT_PROFILE_NAME]);
    expect(list[0]!.isActive).toBe(true);
  });
});

describe('showProfile', () => {
  it('shows the active profile by default and an explicit one by name', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { description: 'the a', clock: CLOCK, env });
    createProfile(dir, 'b', { use: true, clock: CLOCK, env });
    expect(showProfile(dir, undefined, env).name).toBe('b'); // active
    expect(showProfile(dir, 'a', env).description).toBe('the a');
  });
  it('shows the built-in default when none is active', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { clock: CLOCK, env });
    const shown = showProfile(dir, undefined, env);
    expect(shown.name).toBe(DEFAULT_PROFILE_NAME);
    expect(shown.isActive).toBe(true);
  });
  it('throws for an explicit unknown name', () => {
    const { dir, env } = harness();
    expect(() => showProfile(dir, 'ghost', env)).toThrow(/does not exist/);
  });
});

// ──────────────────────────── fs: remove (gating of the destructive purge) ────────────────────────────

describe('removeProfile', () => {
  it('unregisters but KEEPS the home dir by default (non-destructive)', () => {
    const { dir, env } = harness();
    const p = createProfile(dir, 'a', { clock: CLOCK, env });
    const res = removeProfile(dir, 'a', { env });
    expect(res.purged).toBe(false);
    expect(res.wasActive).toBe(false);
    expect(existsSync(p.home)).toBe(true); // home kept
    expect(readProfileRegistry(dir).profiles).toEqual([]);
  });

  it('deletes the home dir only when purge is requested', () => {
    const { dir, env } = harness();
    const p = createProfile(dir, 'a', { use: true, clock: CLOCK, env });
    const res = removeProfile(dir, 'a', { purge: true, env });
    expect(res.purged).toBe(true);
    expect(res.wasActive).toBe(true); // it was active
    expect(existsSync(p.home)).toBe(false); // home deleted
    expect(readProfileRegistry(dir).active).toBeUndefined();
  });

  it('refuses to remove the reserved default', () => {
    const { dir, env } = harness();
    expect(() => removeProfile(dir, 'default', { env })).toThrow(/cannot be removed/);
  });

  it('never purges the standard ~/.mercury even if a profile points there', () => {
    const { dir, env } = harness();
    const standard = defaultHomeRoot(env);
    // Register a profile whose home is the standard ~/.mercury by hand, then purge.
    const reg: ProfileRegistry = { version: 1, profiles: [{ name: 'risky', home: standard, createdAt: CLOCK() }] };
    writeProfileRegistry(dir, reg);
    const res = removeProfile(dir, 'risky', { purge: true, env });
    expect(res.purged).toBe(false); // refused to delete ~/.mercury
  });

  it('throws for an unknown profile', () => {
    const { dir, env } = harness();
    expect(() => removeProfile(dir, 'ghost', { env })).toThrow(/does not exist/);
  });
});

// ──────────────────────────── fs: active home resolution (what mercuryHome() consumes) ────────────────────────────

describe('resolveActiveProfileHome', () => {
  it('returns the active profile home, honouring MERCURY_PROFILE override', () => {
    const { dir, env } = harness();
    const a = createProfile(dir, 'a', { clock: CLOCK, env });
    const b = createProfile(dir, 'b', { use: true, clock: CLOCK, env });
    expect(resolveActiveProfileHome(env)).toBe(b.home);
    expect(resolveActiveProfileHome({ ...env, [PROFILE_ENV_VAR]: 'a' })).toBe(a.home);
  });
  it('returns undefined when an explicit MERCURY_HOME is set (explicit env always wins)', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { use: true, clock: CLOCK, env });
    expect(resolveActiveProfileHome({ ...env, MERCURY_HOME: '/explicit/home' })).toBeUndefined();
  });
  it('returns undefined when no profile is active (implicit default)', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { clock: CLOCK, env });
    expect(resolveActiveProfileHome(env)).toBeUndefined();
  });
  it('returns undefined for a fresh registry and never throws', () => {
    const { env } = harness();
    expect(resolveActiveProfileHome(env)).toBeUndefined();
  });
});

// ──────────────────────────── robustness + helpers ────────────────────────────

describe('readProfileRegistry', () => {
  it('returns an empty registry for a missing or corrupt file (never throws)', () => {
    const { dir } = harness();
    expect(readProfileRegistry(dir).profiles).toEqual([]); // missing
    mkdirSync(dir, { recursive: true });
    writeFileSync(profileRegistryPath(dir), '{ not json');
    expect(readProfileRegistry(dir).profiles).toEqual([]); // corrupt
  });
  it('round-trips a written registry', () => {
    const { dir, env } = harness();
    createProfile(dir, 'a', { use: true, clock: CLOCK, env });
    const raw = JSON.parse(readFileSync(profileRegistryPath(dir), 'utf8'));
    expect(raw.active).toBe('a');
    expect(raw.version).toBe(1);
  });
});

describe('profileRegistryDir / profileHomeEntryCount', () => {
  it('honours MERCURY_PROFILES_DIR for the registry directory', () => {
    expect(profileRegistryDir({ [PROFILES_DIR_ENV_VAR]: '/tmp/reg' })).toBe('/tmp/reg');
  });
  it('counts top-level entries of a home dir (0 when absent)', () => {
    const { dir, env } = harness();
    const p = createProfile(dir, 'a', { clock: CLOCK, env });
    expect(profileHomeEntryCount(p.home)).toBe(0);
    writeFileSync(join(p.home, 'config.yaml'), 'x');
    mkdirSync(join(p.home, 'skills'));
    expect(profileHomeEntryCount(p.home)).toBe(2);
    expect(readdirSync(p.home).length).toBe(2);
    expect(profileHomeEntryCount(join(dir, 'nope'))).toBe(0);
  });
});
