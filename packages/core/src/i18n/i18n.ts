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

/** Locales Mercury ships complete UI/CLI catalogs for. English is always the fallback. */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Resolve the active UI/CLI locale from (in priority order) an explicit value, the
 * `MERCURY_LANG` env var, the `MERCURY_LOCALE` env var, the loaded `config.locale`, and
 * finally English. A region tag is dropped (`de_DE`/`de-AT` → `de`), the value is lower-cased,
 * and anything outside {@link SUPPORTED_LOCALES} falls back to `'en'` so the resolver never
 * returns a locale without a catalog.
 */
export function resolveLocale(opts: { configLocale?: string; env?: NodeJS.ProcessEnv } = {}): SupportedLocale {
  const env = opts.env ?? process.env;
  const raw = (env.MERCURY_LANG || env.MERCURY_LOCALE || opts.configLocale || 'en').trim().toLowerCase();
  const short = raw.split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(short) ? (short as SupportedLocale) : 'en';
}

function lookup(cat: Catalog | undefined, key: string): string | undefined {
  if (!cat) return undefined;
  if (typeof cat[key] === 'string') return cat[key] as string;
  const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Catalog)[k] : undefined), cat);
  return typeof v === 'string' ? v : undefined;
}
