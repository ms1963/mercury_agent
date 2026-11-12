/**
 * Project context files (Hermes/Claude/Cursor conventions). Discovered from the
 * working directory upwards (stopping at the home directory or a .git root):
 *   AGENTS.md, CLAUDE.md, .mercury.md, .cursorrules  → project instructions
 *   SOUL.md                                          → persona override
 * Content is size-capped and heuristically scanned for injection; suspicious files
 * are included but wrapped as untrusted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanForInjection, spotlight } from '../security/injection.js';

export const CONTEXT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', '.mercury.md', '.cursorrules', 'SOUL.md'];
const MAX_CHARS = 8000;

export interface ContextFile {
  name: string;
  path: string;
  content: string;
  suspicious: boolean;
}

export function discoverContextFiles(workdir: string, maxLevels = 6): ContextFile[] {
  const found: ContextFile[] = [];
  const seen = new Set<string>();
  let dir = workdir;
  for (let level = 0; level < maxLevels; level++) {
    for (const name of CONTEXT_FILE_NAMES) {
      const path = join(dir, name);
      if (seen.has(name) || !existsSync(path) || !statSync(path).isFile()) continue;
      seen.add(name); // nearest file wins
      const content = readFileSync(path, 'utf8').slice(0, MAX_CHARS);
      found.push({ name, path, content, suspicious: scanForInjection(content).suspicious });
    }
    if (existsSync(join(dir, '.git')) || dir === homedir()) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Render context files for the system prompt. */
export function renderContextFiles(files: ContextFile[]): { instructions: string; soul?: string } {
  const soul = files.find((f) => f.name === 'SOUL.md');
  const instructions = files
    .filter((f) => f.name !== 'SOUL.md')
    .map((f) => `### ${f.name}\n${f.suspicious ? spotlight(f.content, `context-file:${f.name}`) : f.content}`)
    .join('\n\n');
  return { instructions, soul: soul && !soul.suspicious ? soul.content : undefined };
}
