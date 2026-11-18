/**
 * Offline, deterministic tests for the unified Add-In system (loader + permission
 * profiles + scaffold). Pure filesystem + parsing — no LLM, no network. Temp dirs only.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAddins, loadPermissionProfiles, scaffoldAddin } from '@mercury/core';

const tmps: string[] = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mercury-addins-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** Write a complete, valid add-in under <base>/<name>/. */
function writeAddin(base: string, name: string, opts: { enabled?: boolean } = {}): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'personalities'), { recursive: true });
  mkdirSync(join(dir, 'tools', 'greet'), { recursive: true });
  writeFileSync(
    join(dir, 'addin.yaml'),
    `name: ${name}\nversion: 1.2.3\ndescription: test pack\nenabled: ${opts.enabled ?? true}\n` +
      `personalities:\n  - personalities/pirate.md\ntools:\n  - tools/greet\n` +
      `permissions:\n  pirate:\n    deniedToolsets: [shell]\n    maxToolRisk: safe\n`,
  );
  writeFileSync(join(dir, 'personalities', 'pirate.md'), '# Pirate\nYarr, you are a pirate.');
  writeFileSync(join(dir, 'tools', 'greet', 'tool.json'), JSON.stringify({ name: 'greet', description: 'hi', command: ['echo'] }));
}

describe('add-in loader', () => {
  it('a valid manifest contributes personalities, tool dirs and permission profiles', () => {
    const base = mk();
    writeAddin(base, 'pack');
    const r = loadAddins([base]);
    expect(r.warnings).toEqual([]);
    expect(r.addins).toHaveLength(1);
    expect(r.personalities.map((p) => p.name)).toContain('pirate');
    expect(r.toolDirs).toHaveLength(1);
    expect(r.toolDirs[0]).toContain(join('pack', 'tools', 'greet'));
    expect(r.permissions.pirate).toMatchObject({ deniedToolsets: ['shell'], maxToolRisk: 'safe' });
  });

  it('an enabled=false add-in contributes nothing but is still listed', () => {
    const base = mk();
    writeAddin(base, 'off', { enabled: false });
    const r = loadAddins([base]);
    expect(r.addins).toHaveLength(1);
    expect(r.addins[0].enabled).toBe(false);
    expect(r.personalities).toEqual([]);
    expect(r.toolDirs).toEqual([]);
    expect(r.permissions).toEqual({});
  });

  it('a malformed manifest is skipped with a warning and never throws', () => {
    const base = mk();
    writeAddin(base, 'good');
    const bad = join(base, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'addin.yaml'), 'name: "has spaces not allowed!!"\nversion: 1\n');
    const noManifest = join(base, 'empty');
    mkdirSync(noManifest, { recursive: true });
    let r!: ReturnType<typeof loadAddins>;
    expect(() => {
      r = loadAddins([base]);
    }).not.toThrow();
    expect(r.addins.map((a) => a.name)).toEqual(['good']);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('a missing base dir yields an empty result (legacy coexistence: no addins dir)', () => {
    const r = loadAddins([join(mk(), 'does-not-exist')]);
    expect(r.addins).toEqual([]);
    expect(r.personalities).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('skips personality/tool paths that escape the add-in dir (path-traversal guard)', () => {
    const base = mk();
    const dir = join(base, 'escaper');
    mkdirSync(dir, { recursive: true });
    // Create a real file OUTSIDE the add-in dir that the manifest tries to reach via ../.
    writeFileSync(join(base, 'secret.md'), '# Secret\nShould never be loaded.');
    writeFileSync(
      join(dir, 'addin.yaml'),
      'name: escaper\nversion: 1.0.0\n' +
        'personalities:\n  - ../secret.md\n' +
        'tools:\n  - ../../etc\n',
    );
    const r = loadAddins([base]);
    expect(r.addins).toHaveLength(1);
    expect(r.personalities).toEqual([]); // escaping personality rejected
    expect(r.toolDirs).toEqual([]); // escaping tool dir rejected
    expect(r.warnings.some((w) => w.includes('escapes the add-in dir'))).toBe(true);
  });

  it('warns on a declared personality file that does not exist and a tool dir without tool.json', () => {
    const base = mk();
    const dir = join(base, 'incomplete');
    mkdirSync(join(dir, 'tools', 'empty'), { recursive: true }); // no tool.json inside
    writeFileSync(
      join(dir, 'addin.yaml'),
      'name: incomplete\nversion: 1.0.0\n' +
        'personalities:\n  - personalities/missing.md\n' +
        'tools:\n  - tools/empty\n',
    );
    const r = loadAddins([base]);
    expect(r.addins).toHaveLength(1);
    expect(r.personalities).toEqual([]);
    expect(r.toolDirs).toEqual([]);
    expect(r.warnings.some((w) => w.includes('not found'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('no tool.json'))).toBe(true);
  });

  it('ignores non-directory entries in a base dir', () => {
    const base = mk();
    writeAddin(base, 'real');
    writeFileSync(join(base, 'loose-file.txt'), 'not an add-in'); // a stray file next to add-ins
    const r = loadAddins([base]);
    expect(r.addins.map((a) => a.name)).toEqual(['real']);
    expect(r.warnings).toEqual([]);
  });

  it('aggregates enabled add-in permission profiles into the result', () => {
    const base = mk();
    writeAddin(base, 'pack'); // its manifest declares a `pirate` permission profile
    const r = loadAddins([base]);
    expect(r.permissions.pirate).toMatchObject({ deniedToolsets: ['shell'], maxToolRisk: 'safe' });
  });

  it('duplicate add-in names keep the first and warn on the later copy', () => {
    const base1 = mk();
    const base2 = mk();
    writeAddin(base1, 'dup');
    writeAddin(base2, 'dup');
    const r = loadAddins([base1, base2]);
    expect(r.addins).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('duplicate name'))).toBe(true);
  });
});

describe('permission profiles loader', () => {
  it('reads a single-policy file (name = file name) and a name→policy map file', () => {
    const dir = mk();
    writeFileSync(join(dir, 'auditor.yaml'), 'deniedToolsets: [shell]\nmaxToolRisk: safe\n');
    writeFileSync(join(dir, 'bundle.yaml'), 'reader:\n  allowedTools: [web_search]\nwriter:\n  maxToolRisk: moderate\n');
    const r = loadPermissionProfiles([dir]);
    expect(r.warnings).toEqual([]);
    expect(r.profiles.auditor).toMatchObject({ deniedToolsets: ['shell'], maxToolRisk: 'safe' });
    expect(r.profiles.reader).toMatchObject({ allowedTools: ['web_search'] });
    expect(r.profiles.writer).toMatchObject({ maxToolRisk: 'moderate' });
  });

  it('skips invalid files with a warning and never throws', () => {
    const dir = mk();
    writeFileSync(join(dir, 'bad.yaml'), 'maxToolRisk: nonsense-level\n');
    let r!: ReturnType<typeof loadPermissionProfiles>;
    expect(() => {
      r = loadPermissionProfiles([dir]);
    }).not.toThrow();
    expect(Object.keys(r.profiles)).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('add-in scaffold', () => {
  it('writes a ready-to-load add-in that the loader then accepts', () => {
    const base = mk();
    const res = scaffoldAddin('demo', base);
    expect(res.path).toBe(join(base, 'demo'));
    expect(res.files.some((f) => f.endsWith('addin.yaml'))).toBe(true);
    const loaded = loadAddins([base]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.addins.map((a) => a.name)).toEqual(['demo']);
    expect(loaded.personalities).toHaveLength(1);
    expect(loaded.toolDirs).toHaveLength(1);
    expect(Object.keys(loaded.permissions)).toHaveLength(1);
  });

  it('rejects an invalid name and refuses to overwrite an existing add-in', () => {
    const base = mk();
    expect(() => scaffoldAddin('bad name', base)).toThrow();
    scaffoldAddin('once', base);
    expect(() => scaffoldAddin('once', base)).toThrow();
  });
});
