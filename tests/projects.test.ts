/**
 * Tests for the project/workspace surface (`mercury project ...`), i.e. the core module
 * packages/core/src/projects/manage.ts.
 *
 * SCOPE: fully offline and deterministic. The PURE registry logic (validate / parse / serialize / CRUD /
 * active resolution) is exercised with plain objects and an injected env; the fs layer (create / use /
 * remove / list / show / resolveActiveProjectDataDir) runs against real temp "home" directories
 * (mkdtempSync + afterEach rmSync) with an injected clock so timestamps are deterministic.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateProjectName,
  emptyRegistry,
  parseRegistry,
  serializeRegistry,
  findProject,
  addProject,
  removeProjectEntry,
  setActive,
  resolveActive,
  defaultProjectDataDir,
  createProject,
  useProject,
  clearActive,
  removeProject,
  listProjects,
  showProject,
  readRegistry,
  resolveActiveProjectDataDir,
  activeProjectName,
  registryPath,
  PROJECT_ENV_VAR,
  PROJECT_REGISTRY_FILE,
  type Project,
  type ProjectRegistry,
} from '@mercury/core';

// ──────────────────────────── temp-home harness ────────────────────────────

const tmpDirs: string[] = [];
function mkhome(): string {
  const d = mkdtempSync(join(tmpdir(), 'merc-projects-'));
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

/** A plain project fixture (pure tests). */
function proj(name: string, over: Partial<Project> = {}): Project {
  return { name, dataDir: `/data/${name}`, folders: [], createdAt: '2024-01-01T00:00:00.000Z', ...over };
}

// ──────────────────────────── pure: validateProjectName ────────────────────────────

describe('validateProjectName', () => {
  it('accepts safe names and trims', () => {
    expect(validateProjectName('  work_1.2-x ')).toBe('work_1.2-x');
  });
  it('rejects traversal, separators, leading dots, bad chars, too-long, empty', () => {
    expect(() => validateProjectName('')).toThrow();
    expect(() => validateProjectName('..')).toThrow();
    expect(() => validateProjectName('.hidden')).toThrow();
    expect(() => validateProjectName('a/b')).toThrow();
    expect(() => validateProjectName('a\\b')).toThrow();
    expect(() => validateProjectName('bad name!')).toThrow();
    expect(() => validateProjectName('x'.repeat(65))).toThrow();
  });
});

// ──────────────────────────── pure: parse / serialize ────────────────────────────

describe('parseRegistry', () => {
  it('returns an empty registry for junk', () => {
    expect(parseRegistry(null).projects).toEqual([]);
    expect(parseRegistry(42).projects).toEqual([]);
    expect(parseRegistry('nope').projects).toEqual([]);
  });
  it('drops malformed entries and de-duplicates by name (first wins)', () => {
    const reg = parseRegistry({
      projects: [
        { name: 'a', dataDir: '/d/a', createdAt: 't' },
        { name: 'a', dataDir: '/d/a2', createdAt: 't' }, // dup → dropped
        { name: 'b' }, // no dataDir → dropped
        { dataDir: '/d/x' }, // no name → dropped
        'garbage',
      ],
    });
    expect(reg.projects.map((p) => p.name)).toEqual(['a']);
    expect(reg.projects[0]!.dataDir).toBe('/d/a');
  });
  it('clears an active that names no known project', () => {
    const reg = parseRegistry({ active: 'ghost', projects: [{ name: 'a', dataDir: '/d/a', createdAt: 't' }] });
    expect(reg.active).toBeUndefined();
  });
  it('keeps a valid active', () => {
    const reg = parseRegistry({ active: 'a', projects: [{ name: 'a', dataDir: '/d/a', createdAt: 't' }] });
    expect(reg.active).toBe('a');
  });
});

describe('serializeRegistry', () => {
  it('sorts projects by name and round-trips through parse', () => {
    const reg: ProjectRegistry = { version: 1, active: 'b', projects: [proj('b'), proj('a')] };
    const text = serializeRegistry(reg);
    expect(text.indexOf('"name": "a"')).toBeLessThan(text.indexOf('"name": "b"'));
    const back = parseRegistry(JSON.parse(text));
    expect(back.projects.map((p) => p.name)).toEqual(['a', 'b']);
    expect(back.active).toBe('b');
  });
  it('omits active when none is set', () => {
    const text = serializeRegistry({ version: 1, projects: [proj('a')] });
    expect(text).not.toContain('"active"');
  });
});

// ──────────────────────────── pure: CRUD + selection ────────────────────────────

describe('pure registry CRUD', () => {
  it('addProject appends and refuses duplicates', () => {
    const reg = addProject(emptyRegistry(), proj('a'));
    expect(reg.projects.map((p) => p.name)).toEqual(['a']);
    expect(() => addProject(reg, proj('a'))).toThrow(/already exists/);
  });
  it('removeProjectEntry removes and clears active when it was active', () => {
    let reg = addProject(emptyRegistry(), proj('a'));
    reg = addProject(reg, proj('b'));
    reg = setActive(reg, 'a');
    reg = removeProjectEntry(reg, 'a');
    expect(reg.projects.map((p) => p.name)).toEqual(['b']);
    expect(reg.active).toBeUndefined();
  });
  it('removeProjectEntry keeps active when a different project is removed', () => {
    let reg = addProject(addProject(emptyRegistry(), proj('a')), proj('b'));
    reg = setActive(reg, 'a');
    reg = removeProjectEntry(reg, 'b');
    expect(reg.active).toBe('a');
  });
  it('removeProjectEntry and setActive throw on unknown names', () => {
    expect(() => removeProjectEntry(emptyRegistry(), 'x')).toThrow(/does not exist/);
    expect(() => setActive(emptyRegistry(), 'x')).toThrow(/does not exist/);
  });
  it('findProject resolves by exact name', () => {
    const reg = addProject(emptyRegistry(), proj('a'));
    expect(findProject(reg, 'a')?.name).toBe('a');
    expect(findProject(reg, 'z')).toBeUndefined();
  });
});

describe('resolveActive', () => {
  const reg = setActive(addProject(addProject(emptyRegistry(), proj('a')), proj('b')), 'a');
  it('returns the stored active project', () => {
    expect(resolveActive(reg, {})?.name).toBe('a');
  });
  it('lets MERCURY_PROJECT override the stored active', () => {
    expect(resolveActive(reg, { [PROJECT_ENV_VAR]: 'b' })?.name).toBe('b');
  });
  it('returns undefined when the env override names an unknown project', () => {
    expect(resolveActive(reg, { [PROJECT_ENV_VAR]: 'ghost' })).toBeUndefined();
  });
  it('returns undefined when none is active and no override', () => {
    expect(resolveActive(emptyRegistry(), {})).toBeUndefined();
  });
});

describe('defaultProjectDataDir', () => {
  it('is <home>/projects/<name>', () => {
    expect(defaultProjectDataDir('/home/u/.mercury', 'work')).toBe('/home/u/.mercury/projects/work');
  });
});

// ──────────────────────────── fs: create / use / list / show ────────────────────────────

describe('createProject', () => {
  it('creates the data dir, writes the registry and derives the default data dir', () => {
    const home = mkhome();
    const p = createProject(home, 'alpha', { clock: CLOCK });
    expect(p.dataDir).toBe(defaultProjectDataDir(home, 'alpha'));
    expect(existsSync(p.dataDir)).toBe(true);
    expect(p.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(existsSync(registryPath(home))).toBe(true);
    expect(registryPath(home).endsWith(PROJECT_REGISTRY_FILE)).toBe(true);
    const reg = readRegistry(home);
    expect(reg.projects.map((x) => x.name)).toEqual(['alpha']);
    expect(reg.active).toBeUndefined(); // not active unless --use
  });

  it('honours an explicit data dir, folders, description and --use', () => {
    const home = mkhome();
    const dir = join(home, 'custom-data');
    const folder = join(home, 'code');
    const p = createProject(home, 'beta', { dataDir: dir, folders: [folder], description: 'my beta', use: true, clock: CLOCK });
    expect(p.dataDir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(folder)).toBe(true);
    expect(p.folders).toEqual([folder]);
    expect(p.description).toBe('my beta');
    expect(readRegistry(home).active).toBe('beta');
  });

  it('refuses a duplicate name', () => {
    const home = mkhome();
    createProject(home, 'dup', { clock: CLOCK });
    expect(() => createProject(home, 'dup', { clock: CLOCK })).toThrow(/already exists/);
  });

  it('rejects an invalid name before touching disk', () => {
    const home = mkhome();
    expect(() => createProject(home, '../escape', { clock: CLOCK })).toThrow();
    expect(existsSync(registryPath(home))).toBe(false);
  });
});

describe('useProject / clearActive / activeProjectName', () => {
  it('switches the active project and reports it', () => {
    const home = mkhome();
    createProject(home, 'a', { clock: CLOCK });
    createProject(home, 'b', { clock: CLOCK });
    expect(activeProjectName(home, {})).toBeUndefined();
    useProject(home, 'b');
    expect(activeProjectName(home, {})).toBe('b');
    useProject(home, 'a');
    expect(activeProjectName(home, {})).toBe('a');
    clearActive(home);
    expect(activeProjectName(home, {})).toBeUndefined();
  });
  it('useProject throws for an unknown project', () => {
    const home = mkhome();
    expect(() => useProject(home, 'ghost')).toThrow(/does not exist/);
  });
});

describe('listProjects', () => {
  it('lists sorted by name with active + existence flags', () => {
    const home = mkhome();
    createProject(home, 'zeta', { clock: CLOCK });
    createProject(home, 'alpha', { use: true, clock: CLOCK });
    const list = listProjects(home);
    expect(list.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(list.find((p) => p.name === 'alpha')!.isActive).toBe(true);
    expect(list.find((p) => p.name === 'zeta')!.isActive).toBe(false);
    expect(list.every((p) => p.dataDirExists)).toBe(true);
  });
  it('is empty for a fresh home', () => {
    expect(listProjects(mkhome())).toEqual([]);
  });
});

describe('showProject', () => {
  it('shows the active project by default and an explicit one by name', () => {
    const home = mkhome();
    createProject(home, 'a', { description: 'the a', clock: CLOCK });
    createProject(home, 'b', { use: true, clock: CLOCK });
    expect(showProject(home)!.name).toBe('b'); // active default
    expect(showProject(home, 'a')!.description).toBe('the a');
  });
  it('returns undefined when no name and none active', () => {
    const home = mkhome();
    createProject(home, 'a', { clock: CLOCK });
    expect(showProject(home)).toBeUndefined();
  });
  it('throws for an explicit unknown name', () => {
    const home = mkhome();
    expect(() => showProject(home, 'ghost')).toThrow(/does not exist/);
  });
});

// ──────────────────────────── fs: remove (gating of the destructive purge) ────────────────────────────

describe('removeProject', () => {
  it('unregisters but KEEPS the data dir by default (non-destructive)', () => {
    const home = mkhome();
    const p = createProject(home, 'a', { clock: CLOCK });
    const res = removeProject(home, 'a');
    expect(res.purged).toBe(false);
    expect(res.wasActive).toBe(false);
    expect(existsSync(p.dataDir)).toBe(true); // data dir kept
    expect(readRegistry(home).projects).toEqual([]);
  });

  it('deletes the data dir only when purge is requested', () => {
    const home = mkhome();
    const p = createProject(home, 'a', { use: true, clock: CLOCK });
    const res = removeProject(home, 'a', { purge: true });
    expect(res.purged).toBe(true);
    expect(res.wasActive).toBe(true); // it was active
    expect(existsSync(p.dataDir)).toBe(false); // data dir deleted
    expect(readRegistry(home).active).toBeUndefined();
  });

  it('throws for an unknown project', () => {
    const home = mkhome();
    expect(() => removeProject(home, 'ghost')).toThrow(/does not exist/);
  });
});

// ──────────────────────────── fs: active data-dir resolution (what loadConfig consumes) ────────────────────────────

describe('resolveActiveProjectDataDir', () => {
  it('returns the active project data dir, honouring MERCURY_PROJECT override', () => {
    const home = mkhome();
    const a = createProject(home, 'a', { clock: CLOCK });
    const b = createProject(home, 'b', { use: true, clock: CLOCK });
    expect(resolveActiveProjectDataDir(home, {})).toBe(b.dataDir);
    expect(resolveActiveProjectDataDir(home, { [PROJECT_ENV_VAR]: 'a' })).toBe(a.dataDir);
  });
  it('returns undefined when no project is active', () => {
    const home = mkhome();
    createProject(home, 'a', { clock: CLOCK });
    expect(resolveActiveProjectDataDir(home, {})).toBeUndefined();
  });
  it('returns undefined for a fresh home (no registry)', () => {
    expect(resolveActiveProjectDataDir(mkhome(), {})).toBeUndefined();
  });
});

// ──────────────────────────── robustness: corrupt registry file ────────────────────────────

describe('readRegistry', () => {
  it('returns an empty registry for a missing or corrupt file (never throws)', () => {
    const home = mkhome();
    expect(readRegistry(home).projects).toEqual([]); // missing
    mkdirSync(home, { recursive: true });
    writeFileSync(registryPath(home), '{ not json');
    expect(readRegistry(home).projects).toEqual([]); // corrupt
  });
  it('round-trips a written registry', () => {
    const home = mkhome();
    createProject(home, 'a', { use: true, clock: CLOCK });
    const raw = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    expect(raw.active).toBe('a');
    expect(raw.version).toBe(1);
  });
});
