/**
 * Install skills from a local folder or a git repository (Skills Hub style).
 * A source may contain one skill (SKILL.md at its root) or many (sub-folders).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { MercuryError } from '../types/common.js';
import { parseSkill, slugify } from './parser.js';
import type { SkillRegistry } from './registry.js';

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/).+/.test(source) || source.endsWith('.git');
}

/**
 * Only clone over https (or git@/ssh:// for operator-configured keys). Rejects option-looking
 * sources and git transport tricks (ext::, file://, fd::) that could execute commands.
 */
export function assertSafeGitUrl(source: string): void {
  const ok = /^https:\/\/[\w.-]+(:\d+)?\/[\w./~%-]+$/.test(source) || /^ssh:\/\/[\w.-]+@?[\w.-]*(:\d+)?\/[\w./~%-]+$/.test(source) || /^git@[\w.-]+:[\w./~-]+$/.test(source);
  if (!ok || source.startsWith('-') || source.includes('::')) throw new MercuryError(`Refusing git source (use https://…): ${source}`, 'install_failed', 'skills');
}

/** Install and return the names of installed skills. */
export function installSkills(registry: SkillRegistry, source: string, opts: { subdir?: string } = {}): string[] {
  let root = resolve(source);
  let cleanup: string | undefined;
  if (isGitUrl(source)) {
    assertSafeGitUrl(source);
    cleanup = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-skill-'));
    try {
      execFileSync('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--no-recurse-submodules', '--', source, cleanup], { stdio: 'ignore', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (err) {
      rmSync(cleanup, { recursive: true, force: true });
      throw new MercuryError(`git clone failed: ${String(err)}`, 'install_failed', 'skills');
    }
    root = cleanup;
  }
  if (opts.subdir) {
    const sub = resolve(root, opts.subdir);
    const rel = relative(root, sub);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      if (cleanup) rmSync(cleanup, { recursive: true, force: true });
      throw new MercuryError('subdir must stay inside the source', 'install_failed', 'skills');
    }
    root = sub;
  }
  try {
    if (!existsSync(root)) throw new MercuryError(`Skill source not found: ${source}`, 'install_failed', 'skills');
    const candidates = existsSync(join(root, 'SKILL.md'))
      ? [root]
      : readdirSync(root).map((e) => join(root, e)).filter((d) => existsSync(join(d, 'SKILL.md')));
    if (!candidates.length) throw new MercuryError('No SKILL.md found in source', 'install_failed', 'skills');
    const installed: string[] = [];
    for (const dir of candidates) {
      const { meta } = parseSkill(readFileSync(join(dir, 'SKILL.md'), 'utf8'), slugify(dir.split('/').pop() ?? 'skill'));
      const name = slugify(meta.name);
      cpSync(dir, join(registry.userDir, name), { recursive: true, filter: (p) => !p.includes('/.git') && !lstatSync(p).isSymbolicLink() });
      installed.push(name);
    }
    registry.reload();
    return installed;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}
