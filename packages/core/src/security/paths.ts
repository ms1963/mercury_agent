/**
 * Path jail: file tools may only touch paths inside the configured roots.
 * Symlinks are resolved so `ln -s / escape` cannot break out.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PermissionDeniedError } from '../types/common.js';

const SENSITIVE = [/(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /^\/etc\/(shadow|sudoers)/, /(^|\/)secret\.key$/, /(^|\/)mercury\.db(-wal|-shm|-journal)?$/, /^\/proc\/[^/]+\/environ$/];

export class PathJail {
  readonly roots: string[];
  private readonly protectedDirs: string[];
  /**
   * @param protectedDirs directories whose contents are off-limits (e.g. Mercury's data dir with the
   *   database, JWT secret and config) — except for roots strictly inside them (the workspace).
   */
  constructor(roots: string[], private allowOutside = false, protectedDirs: string[] = []) {
    this.roots = roots.map((r) => realOrResolved(resolve(r)));
    this.protectedDirs = protectedDirs.map((d) => realOrResolved(resolve(d)));
  }

  /** Resolve a user-supplied path and verify it is inside a root. Returns the absolute path. */
  check(p: string, base = this.roots[0] ?? process.cwd()): string {
    const abs = isAbsolute(p) ? resolve(p) : resolve(base, p);
    const real = realOrResolved(abs);
    if (SENSITIVE.some((re) => re.test(real))) throw new PermissionDeniedError(`Access to sensitive path denied: ${p}`);
    for (const dir of this.protectedDirs) {
      if (!isInside(dir, real)) continue;
      const carveOut = this.roots.some((root) => root !== dir && isInside(dir, root) && isInside(root, real));
      if (!carveOut) throw new PermissionDeniedError(`Access to Mercury's data directory denied: ${p}`);
    }
    if (this.allowOutside) return real;
    if (this.roots.some((root) => isInside(root, real))) return real;
    throw new PermissionDeniedError(`Path outside the allowed workspace: ${p} (allowed: ${this.roots.join(', ')})`);
  }

  contains(p: string): boolean {
    try {
      this.check(p);
      return true;
    } catch {
      return false;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** realpath for existing paths; for new files, realpath of the nearest existing parent. */
function realOrResolved(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return p;
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length ? resolve(real, ...tail) : real;
}
