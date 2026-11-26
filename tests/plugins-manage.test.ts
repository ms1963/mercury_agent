/**
 * Tests for the plugin-lifecycle surface (`mercury plugins install|update|remove`), i.e. the core module
 * packages/core/src/plugins/manage.ts.
 *
 * SCOPE: fully offline and deterministic. No network, no real `git`. The PURE source/name resolution
 * (parseSource / deriveName / validateName) is exercised directly; the fs/exec layer (install / update /
 * remove / listInstalled) runs against real temp directories (mkdtempSync + afterEach rmSync) with an
 * INJECTED fake command runner that records calls and fabricates a cloned directory on `git clone`, so a
 * git install/update never shells out or hits the network.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSource,
  deriveName,
  validateName,
  isPluginDir,
  readManifest,
  installPlugin,
  updatePlugin,
  removePlugin,
  listInstalled,
  PLUGIN_MANIFEST,
  type CommandRunner,
} from '@mercury/core';

// ──────────────────────────── temp-dir harness ────────────────────────────

const tmpDirs: string[] = [];
function mktmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'merc-plugins-'));
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

/** Create a minimal loadable plugin directory (index.js + optional package.json). */
function makePluginSource(opts: { pkg?: Record<string, unknown>; body?: string } = {}): string {
  const dir = mktmp();
  writeFileSync(join(dir, 'index.js'), opts.body ?? 'export function setup(){}\n');
  if (opts.pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(opts.pkg, null, 2));
  return dir;
}

/** A fake runner that records every call and fabricates a cloned plugin dir on `git clone`. */
function fakeGitRunner(): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const runner: CommandRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === 'git' && args[0] === 'clone') {
      const dest = args[2]!; // git clone <url> <dest>
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'index.js'), 'export function setup(){}\n');
      writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'cloned', version: '2.0.0' }));
    }
  };
  return { runner, calls };
}

const CLOCK = () => '2024-01-01T00:00:00.000Z';

// ──────────────────────────── pure: parseSource ────────────────────────────

describe('parseSource', () => {
  it('classifies https/ssh/.git/git+/scp URLs as git', () => {
    expect(parseSource('https://github.com/a/b.git').type).toBe('git');
    expect(parseSource('https://github.com/a/b').type).toBe('git');
    expect(parseSource('git+https://github.com/a/b.git').location).toBe('https://github.com/a/b.git');
    expect(parseSource('git@github.com:a/b.git').type).toBe('git');
    expect(parseSource('ssh://git@host/a/b').type).toBe('git');
  });
  it('treats anything else as a resolved absolute path', () => {
    const s = parseSource('./some/local/dir');
    expect(s.type).toBe('path');
    expect(s.location.startsWith('/')).toBe(true);
  });
  it('rejects an empty source', () => {
    expect(() => parseSource('   ')).toThrow(/empty/);
  });
});

// ──────────────────────────── pure: deriveName ────────────────────────────

describe('deriveName', () => {
  it('derives the repo basename (minus .git) for git sources', () => {
    expect(deriveName(parseSource('https://github.com/acme/cool-plugin.git'))).toBe('cool-plugin');
    expect(deriveName(parseSource('git@github.com:acme/cool-plugin.git'))).toBe('cool-plugin');
  });
  it('derives the basename for a path (minus a .js/.mjs ext)', () => {
    expect(deriveName(parseSource('/x/y/my-plugin'))).toBe('my-plugin');
    expect(deriveName(parseSource('/x/y/my-plugin.mjs'))).toBe('my-plugin');
  });
  it('honours an explicit name over derivation', () => {
    expect(deriveName(parseSource('https://github.com/a/b.git'), 'custom')).toBe('custom');
  });
});

// ──────────────────────────── pure: validateName ────────────────────────────

describe('validateName', () => {
  it('accepts safe names', () => {
    expect(validateName('my.plugin-1_0')).toBe('my.plugin-1_0');
  });
  it('rejects traversal, separators, leading dots and bad chars', () => {
    expect(() => validateName('..')).toThrow();
    expect(() => validateName('.hidden')).toThrow();
    expect(() => validateName('a/b')).toThrow();
    expect(() => validateName('a\\b')).toThrow();
    expect(() => validateName('bad name!')).toThrow();
    expect(() => validateName('')).toThrow();
  });
});

// ──────────────────────────── install (local path) ────────────────────────────

describe('installPlugin (local path)', () => {
  it('copies a directory source, writes a manifest and derives the name', () => {
    const src = makePluginSource({ pkg: { name: 'p', version: '1.2.3' } });
    const plugins = mktmp();
    const res = installPlugin(plugins, src, { clock: CLOCK });
    expect(res.source.type).toBe('path');
    expect(res.version).toBe('1.2.3');
    expect(res.reinstalled).toBe(false);
    expect(existsSync(join(res.dir, 'index.js'))).toBe(true);
    const mani = readManifest(res.dir)!;
    expect(mani.installedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(mani.source.type).toBe('path');
    expect(mani.name).toBe(res.name);
  });

  it('installs a single .js file into <name>.js', () => {
    const file = join(mktmp(), 'solo.js');
    writeFileSync(file, 'export function setup(){}\n');
    const plugins = mktmp();
    const res = installPlugin(plugins, file, { clock: CLOCK });
    expect(res.name).toBe('solo');
    expect(existsSync(join(res.dir, 'solo.js'))).toBe(true);
  });

  it('refuses a duplicate install without force and overwrites with force', () => {
    const src = makePluginSource();
    const plugins = mktmp();
    installPlugin(plugins, src, { clock: CLOCK });
    expect(() => installPlugin(plugins, src, { clock: CLOCK })).toThrow(/already installed/);
    const res = installPlugin(plugins, src, { force: true, clock: CLOCK });
    expect(res.reinstalled).toBe(true);
  });

  it('rejects a path that does not look like a plugin', () => {
    const notPlugin = mktmp(); // empty dir, no entry point
    writeFileSync(join(notPlugin, 'readme.txt'), 'hi');
    const plugins = mktmp();
    expect(() => installPlugin(plugins, notPlugin, { clock: CLOCK })).toThrow(/does not look like a plugin/);
  });

  it('errors on a missing source path', () => {
    const plugins = mktmp();
    expect(() => installPlugin(plugins, '/no/such/path/plugin', { clock: CLOCK })).toThrow(/not found/);
  });

  it('honours an explicit --name', () => {
    const src = makePluginSource();
    const plugins = mktmp();
    const res = installPlugin(plugins, src, { name: 'renamed', clock: CLOCK });
    expect(res.name).toBe('renamed');
    expect(existsSync(join(plugins, 'renamed'))).toBe(true);
  });

  it('runs the build step only when a build script is declared', () => {
    const src = makePluginSource({ pkg: { name: 'p', version: '1.0.0', scripts: { build: 'tsc' } } });
    const plugins = mktmp();
    const { runner, calls } = fakeGitRunner();
    const res = installPlugin(plugins, src, { build: true, runner, clock: CLOCK });
    expect(res.built).toBe(true);
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual(['npm install', 'npm run build']);

    // No build script → no build, no runner calls.
    const src2 = makePluginSource({ pkg: { name: 'q', version: '1.0.0' } });
    const plugins2 = mktmp();
    const r2 = fakeGitRunner();
    const res2 = installPlugin(plugins2, src2, { build: true, runner: r2.runner, clock: CLOCK });
    expect(res2.built).toBe(false);
    expect(r2.calls.length).toBe(0);
  });
});

// ──────────────────────────── install (git, injected runner) ────────────────────────────

describe('installPlugin (git, injected runner)', () => {
  it('clones via the runner (no network) and writes a git manifest', () => {
    const plugins = mktmp();
    const { runner, calls } = fakeGitRunner();
    const res = installPlugin(plugins, 'https://github.com/acme/cool.git', { runner, clock: CLOCK });
    expect(res.name).toBe('cool');
    expect(res.source.type).toBe('git');
    expect(res.version).toBe('2.0.0');
    expect(calls[0]!.cmd).toBe('git');
    expect(calls[0]!.args[0]).toBe('clone');
    const mani = readManifest(res.dir)!;
    expect(mani.source.type).toBe('git');
    expect(mani.source.location).toBe('https://github.com/acme/cool.git');
  });
});

// ──────────────────────────── update ────────────────────────────

describe('updatePlugin', () => {
  it('re-copies a path source and refreshes the manifest', () => {
    const src = makePluginSource({ pkg: { name: 'p', version: '1.0.0' } });
    const plugins = mktmp();
    const inst = installPlugin(plugins, src, { clock: CLOCK });
    // Change the source, then update.
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'p', version: '1.1.0' }));
    const res = updatePlugin(plugins, inst.name, { clock: () => '2024-02-02T00:00:00.000Z' });
    expect(res.method).toBe('recopy');
    expect(res.version).toBe('1.1.0');
    const mani = readManifest(res.dir)!;
    expect(mani.updatedAt).toBe('2024-02-02T00:00:00.000Z');
    expect(mani.version).toBe('1.1.0');
  });

  it('pulls a git source via the runner without hitting the network', () => {
    const plugins = mktmp();
    const { runner, calls } = fakeGitRunner();
    const inst = installPlugin(plugins, 'https://github.com/acme/cool.git', { runner, clock: CLOCK });
    calls.length = 0;
    const res = updatePlugin(plugins, inst.name, { runner });
    expect(res.method).toBe('git-pull');
    expect(calls[0]!.cmd).toBe('git');
    expect(calls[0]!.args).toEqual(['-C', res.dir, 'pull', '--ff-only']);
  });

  it('errors updating a plugin that is not installed', () => {
    const plugins = mktmp();
    expect(() => updatePlugin(plugins, 'ghost')).toThrow(/not installed/);
  });

  it('errors updating a plugin with no manifest', () => {
    const plugins = mktmp();
    const dir = join(plugins, 'manual');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'export function setup(){}\n');
    expect(() => updatePlugin(plugins, 'manual')).toThrow(/no install manifest/);
  });

  it('errors when a path source is gone', () => {
    const src = makePluginSource();
    const plugins = mktmp();
    const inst = installPlugin(plugins, src, { clock: CLOCK });
    rmSync(src, { recursive: true, force: true });
    expect(() => updatePlugin(plugins, inst.name)).toThrow(/original source path is gone/);
  });
});

// ──────────────────────────── remove ────────────────────────────

describe('removePlugin', () => {
  it('removes an installed plugin directory', () => {
    const src = makePluginSource();
    const plugins = mktmp();
    const inst = installPlugin(plugins, src, { clock: CLOCK });
    expect(existsSync(inst.dir)).toBe(true);
    const res = removePlugin(plugins, inst.name);
    expect(res.dir).toBe(inst.dir);
    expect(existsSync(inst.dir)).toBe(false);
  });

  it('errors removing a plugin that is not installed', () => {
    const plugins = mktmp();
    expect(() => removePlugin(plugins, 'ghost')).toThrow(/not installed/);
  });

  it('rejects an unsafe name', () => {
    const plugins = mktmp();
    expect(() => removePlugin(plugins, '../escape')).toThrow();
  });
});

// ──────────────────────────── listInstalled ────────────────────────────

describe('listInstalled', () => {
  it('returns [] for a missing plugins dir', () => {
    expect(listInstalled(join(mktmp(), 'nope'))).toEqual([]);
  });

  it('lists managed and unmanaged plugins, sorted by name', () => {
    const plugins = mktmp();
    installPlugin(plugins, makePluginSource({ pkg: { name: 'zeta', version: '1.0.0' } }), { name: 'zeta', clock: CLOCK });
    installPlugin(plugins, makePluginSource({ pkg: { name: 'alpha', version: '1.0.0' } }), { name: 'alpha', clock: CLOCK });
    // An unmanaged plugin dropped in by hand (no manifest).
    const manual = join(plugins, 'manual');
    mkdirSync(manual, { recursive: true });
    writeFileSync(join(manual, 'index.js'), 'export function setup(){}\n');

    const list = listInstalled(plugins);
    expect(list.map((p) => p.name)).toEqual(['alpha', 'manual', 'zeta']);
    expect(list.find((p) => p.name === 'alpha')!.managed).toBe(true);
    expect(list.find((p) => p.name === 'manual')!.managed).toBe(false);
    expect(list.every((p) => p.entryPresent)).toBe(true);
  });
});

// ──────────────────────────── isPluginDir / manifest guard ────────────────────────────

describe('isPluginDir', () => {
  it('recognises index.js / dist/index.js / package.json main entries', () => {
    const a = mktmp();
    writeFileSync(join(a, 'index.js'), '');
    expect(isPluginDir(a)).toBe(true);

    const b = mktmp();
    mkdirSync(join(b, 'dist'));
    writeFileSync(join(b, 'dist', 'index.js'), '');
    expect(isPluginDir(b)).toBe(true);

    const c = mktmp();
    writeFileSync(join(c, 'package.json'), JSON.stringify({ main: 'lib/entry.js' }));
    mkdirSync(join(c, 'lib'));
    writeFileSync(join(c, 'lib', 'entry.js'), '');
    expect(isPluginDir(c)).toBe(true);
  });

  it('rejects an empty dir and a missing path', () => {
    expect(isPluginDir(mktmp())).toBe(false);
    expect(isPluginDir('/no/such/dir')).toBe(false);
  });
});

// ──────────────────────────── manifest filename guard ────────────────────────────

describe('manifest', () => {
  it('uses the documented manifest filename', () => {
    const src = makePluginSource();
    const plugins = mktmp();
    const inst = installPlugin(plugins, src, { clock: CLOCK });
    expect(existsSync(join(inst.dir, PLUGIN_MANIFEST))).toBe(true);
    expect(PLUGIN_MANIFEST).toBe('.mercury-plugin.json');
    // The manifest is valid JSON.
    expect(() => JSON.parse(readFileSync(join(inst.dir, PLUGIN_MANIFEST), 'utf8'))).not.toThrow();
  });
});
