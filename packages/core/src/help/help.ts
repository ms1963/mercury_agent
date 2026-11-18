/**
 * Help system: Markdown topics in `<assets>/docs/help/*.md` (plus `<dataDir>/help`).
 * Used by `mercury help [topic]`, the `/help` slash command, the web UI help panel and
 * error messages (`MercuryError.helpTopic` → "(help: <topic>)").
 * Localised topics live in `docs/help/<locale>/<topic>.md` and win when present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface HelpTopic {
  name: string;
  title: string;
  summary: string;
}

export class HelpSystem {
  /**
   * @param dirs          help directories (bundled assets, then dataDir overrides)
   * @param defaultLocale effective locale (from `config.locale`, same mechanism that
   *                      powers the German UI); localized topics under `<dir>/<locale>/`
   *                      win over English, which stays the fallback.
   */
  constructor(private dirs: string[], private defaultLocale = 'en') {}

  private file(name: string, locale?: string): string | undefined {
    for (const dir of [...this.dirs].reverse()) {
      const candidates = [locale && locale !== 'en' ? join(dir, locale, `${name}.md`) : '', join(dir, `${name}.md`)].filter(Boolean);
      const hit = candidates.find((c) => existsSync(c));
      if (hit) return hit;
    }
    return undefined;
  }

  topics(locale = this.defaultLocale): HelpTopic[] {
    const names = new Set<string>();
    for (const d of this.dirs) if (existsSync(d)) readdirSync(d).filter((f) => f.endsWith('.md')).forEach((f) => names.add(basename(f, '.md')));
    return [...names].sort().map((name) => {
      const text = readFileSync(this.file(name, locale)!, 'utf8');
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? name;
      const summary = text.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      return { name, title, summary };
    });
  }

  get(name: string, locale = this.defaultLocale): string | undefined {
    const f = this.file(name.toLowerCase().replace(/[^a-z0-9-]/g, ''), locale);
    return f ? readFileSync(f, 'utf8') : undefined;
  }

  search(query: string, locale = this.defaultLocale): HelpTopic[] {
    const q = query.toLowerCase();
    return this.topics(locale).filter((t) => `${t.name} ${t.title} ${t.summary} ${this.get(t.name, locale) ?? ''}`.toLowerCase().includes(q));
  }

  /** Render the topic index as text (CLI / chat). */
  index(locale = this.defaultLocale): string {
    return this.topics(locale).map((t) => `  ${t.name.padEnd(14)} ${t.summary.slice(0, 80)}`).join('\n');
  }
}
