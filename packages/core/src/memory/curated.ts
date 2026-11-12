/**
 * Curated, bounded memory files per user (Hermes-compatible):
 *   MEMORY.md — agent's notes about the environment, conventions, lessons
 *   USER.md   — what the agent knows about the user (preferences, style)
 * Entries are bullet lines; the file is kept under a character limit by dropping the
 * oldest entries, so it always fits into the system prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CuratedFile = 'memory' | 'user';

export class CuratedMemory {
  constructor(
    private dataDir: string,
    private limits: { memory: number; user: number },
  ) {}

  private file(userId: string, which: CuratedFile): string {
    const dir = join(this.dataDir, 'users', userId.replace(/[^\w.-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    return join(dir, which === 'memory' ? 'MEMORY.md' : 'USER.md');
  }

  read(userId: string, which: CuratedFile): string {
    const f = this.file(userId, which);
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }

  entries(userId: string, which: CuratedFile): string[] {
    return this.read(userId, which)
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
  }

  /** Append an entry (deduplicated), trimming oldest entries to stay within the limit. */
  add(userId: string, which: CuratedFile, entry: string): { entries: string[]; dropped: string[] } {
    const clean = entry.replace(/\s+/g, ' ').trim();
    let entries = this.entries(userId, which).filter((e) => e.toLowerCase() !== clean.toLowerCase());
    entries.push(clean);
    const dropped: string[] = [];
    const limit = which === 'memory' ? this.limits.memory : this.limits.user;
    while (render(which, entries).length > limit && entries.length > 1) dropped.push(entries.shift()!);
    if (render(which, entries).length > limit) entries = [clean.slice(0, limit - 40)];
    writeFileSync(this.file(userId, which), render(which, entries));
    return { entries, dropped };
  }

  remove(userId: string, which: CuratedFile, match: string): number {
    const before = this.entries(userId, which);
    const after = before.filter((e) => !e.toLowerCase().includes(match.toLowerCase()));
    writeFileSync(this.file(userId, which), render(which, after));
    return before.length - after.length;
  }

  /** Replace the whole file (memory editor in the UI). */
  write(userId: string, which: CuratedFile, content: string): void {
    const limit = which === 'memory' ? this.limits.memory : this.limits.user;
    writeFileSync(this.file(userId, which), content.slice(0, limit));
  }

  usage(userId: string): { memory: { chars: number; limit: number }; user: { chars: number; limit: number } } {
    return {
      memory: { chars: this.read(userId, 'memory').length, limit: this.limits.memory },
      user: { chars: this.read(userId, 'user').length, limit: this.limits.user },
    };
  }
}

function render(which: CuratedFile, entries: string[]): string {
  const title = which === 'memory' ? '# MEMORY' : '# USER';
  return `${title}\n${entries.map((e) => `- ${e}`).join('\n')}\n`;
}
