/**
 * Install skills from a local folder or a git repository (Skills Hub style).
 * A source may contain one skill (SKILL.md at its root) or many (sub-folders).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MercuryError } from '../types/common.js';
import { parseSkill, slugify } from './parser.js';
import type { SkillRegistry } from './registry.js';

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/).+/.test(source) || source.endsWith('.git');
}

/** Install and return the names of installed skills. */
export function installSkills(registry: SkillRegistry, source: string, opts: { subdir?: string } = {}): string[] {
  let root = resolve(source);
  let cleanup: string | undefined;
  if (isGitUrl(source)) {
    cleanup = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-skill-'));
    try {
      execFileSync('git', ['clone', '--depth', '1', source, cleanup], { stdio: 'ignore', timeout: 120_000 });
    } catch (err) {
      rmSync(cleanup, { recursive: true, force: true });
      throw new MercuryError(`git clone failed: ${String(err)}`, 'install_failed', 'skills');
    }
    root = cleanup;
  }
  if (opts.subdir) root = join(root, opts.subdir);
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
      cpSync(dir, join(registry.userDir, name), { recursive: true, filter: (p) => !p.includes('/.git') });
      installed.push(name);
    }
    registry.reload();
    return installed;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}
