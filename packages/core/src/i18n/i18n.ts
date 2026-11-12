/**
 * Minimal i18n: flat-or-nested JSON catalogs in `<assets>/locales/<lang>.json`.
 * `t('chat.placeholder', { name })` looks up the key in the requested locale, falls
 * back to English, then to the key itself. `{var}` placeholders are interpolated.
 * The web UI loads the same catalogs via GET /api/i18n/:locale.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Catalog = Record<string, unknown>;

export class I18n {
  private catalogs = new Map<string, Catalog>();

  constructor(private dir: string, public locale = 'en') {
    this.reload();
  }

  reload(): void {
    this.catalogs.clear();
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith('.json'))) {
      this.catalogs.set(basename(f, '.json'), JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Catalog);
    }
  }

  locales(): string[] {
    return [...this.catalogs.keys()].sort();
  }

  catalog(locale: string): Catalog {
    return this.catalogs.get(locale) ?? this.catalogs.get('en') ?? {};
  }

  t(key: string, vars: Record<string, string | number> = {}, locale = this.locale): string {
    const raw = lookup(this.catalogs.get(locale), key) ?? lookup(this.catalogs.get('en'), key) ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
  }
}

function lookup(cat: Catalog | undefined, key: string): string | undefined {
  if (!cat) return undefined;
  if (typeof cat[key] === 'string') return cat[key] as string;
  const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Catalog)[k] : undefined), cat);
  return typeof v === 'string' ? v : undefined;
}
