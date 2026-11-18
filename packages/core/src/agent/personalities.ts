/**
 * Personalities: named persona prompts (Hermes `/personality`). Loaded from
 * `<assets>/personalities/*.md` and `<dataDir>/personalities/*.md`; the file name is the
 * personality name, the first heading/line is its title. A SOUL.md context file
 * overrides the persona for a project.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Personality {
  name: string;
  title: string;
  prompt: string;
}

const BUILTIN: Personality[] = [
  { name: 'default', title: 'Mercury', prompt: 'You are Mercury, a capable, honest and concise AI agent. You use tools when they help, verify important claims, and say clearly when you are unsure.' },
];

export class Personalities {
  private items = new Map<string, Personality>();

  /**
   * @param dirs  directories scanned for drop-in `*.md` personalities.
   * @param extra optional provider of additional personalities (e.g. contributed by
   *              Add-Ins). Evaluated on every reload so hot-reloaded add-ins apply.
   */
  constructor(private dirs: string[], private extra: () => Personality[] = () => []) {
    this.reload();
  }

  reload(): void {
    this.items.clear();
    for (const p of BUILTIN) this.items.set(p.name, p);
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const text = readFileSync(join(dir, f), 'utf8').trim();
        const title = (/^#\s*(.+)$/m.exec(text)?.[1] ?? basename(f, '.md')).trim();
        this.items.set(basename(f, '.md'), { name: basename(f, '.md'), title, prompt: text.replace(/^#.*\n?/, '').trim() });
      }
    }
    // Add-in personalities are applied last (they can override drop-ins by name).
    for (const p of this.extra()) this.items.set(p.name, p);
  }

  list(): Personality[] {
    return [...this.items.values()];
  }

  get(name?: string): Personality {
    return this.items.get(name ?? 'default') ?? this.items.get('default')!;
  }

  has(name: string): boolean {
    return this.items.has(name);
  }
}
