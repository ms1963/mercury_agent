/**
 * i18n (v2.1.0): the language resolver, EN/DE message-catalog key parity, and EN/DE help-topic
 * file parity. These guard the "complete English + German" guarantee so the two languages can
 * never silently drift apart.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir, I18n, resolveLocale, SUPPORTED_LOCALES } from '@mercury/core';

const localesDir = join(assetsDir(), 'locales');
const helpDir = join(assetsDir(), 'docs', 'help');

/** Recursively collect the dotted leaf keys of a (possibly nested) catalog object. */
function leafKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, key));
    else out.push(key);
  }
  return out;
}

const readCatalog = (lang: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(localesDir, `${lang}.json`), 'utf8')) as Record<string, unknown>;

describe('resolveLocale', () => {
  it('defaults to English when nothing is set', () => {
    expect(resolveLocale({ env: {} })).toBe('en');
    expect(resolveLocale()).toMatch(/^(en|de)$/); // process env — never undefined
  });

  it('returns German when German is selected via config', () => {
    expect(resolveLocale({ configLocale: 'de', env: {} })).toBe('de');
  });

  it('honours MERCURY_LANG and MERCURY_LOCALE env vars', () => {
    expect(resolveLocale({ env: { MERCURY_LANG: 'de' } })).toBe('de');
    expect(resolveLocale({ env: { MERCURY_LOCALE: 'de' } })).toBe('de');
  });

  it('prioritises MERCURY_LANG > MERCURY_LOCALE > config', () => {
    expect(resolveLocale({ env: { MERCURY_LANG: 'de', MERCURY_LOCALE: 'en' }, configLocale: 'en' })).toBe('de');
    expect(resolveLocale({ env: { MERCURY_LOCALE: 'de' }, configLocale: 'en' })).toBe('de');
  });

  it('normalises region tags and casing (de_DE / de-AT / DE → de)', () => {
    expect(resolveLocale({ env: { MERCURY_LANG: 'de_DE' } })).toBe('de');
    expect(resolveLocale({ env: { MERCURY_LANG: 'de-AT' } })).toBe('de');
    expect(resolveLocale({ env: { MERCURY_LANG: 'DE' } })).toBe('de');
  });

  it('falls back to English for an unsupported locale', () => {
    expect(resolveLocale({ env: { MERCURY_LANG: 'fr' } })).toBe('en');
    expect(resolveLocale({ configLocale: 'zz' })).toBe('en');
  });

  it('ships catalogs for every supported locale', () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(existsSync(join(localesDir, `${loc}.json`)), `missing locales/${loc}.json`).toBe(true);
    }
  });
});

describe('I18n catalog resolution', () => {
  const i18n = new I18n(localesDir);

  it('returns the English string by default', () => {
    expect(i18n.t('app.name')).toBe('Mercury');
    expect(i18n.t('cli.fallback.cleared', { file: '/x' })).toBe('✓ cleared the fallback chain → /x');
  });

  it('returns the German string when German is requested', () => {
    expect(i18n.t('cli.fallback.cleared', { file: '/x' }, 'de')).toBe('✓ Fallback-Kette geleert → /x');
    expect(i18n.t('cli.route.catchAll', {}, 'de')).toBe('Standard (Auffang)');
    expect(i18n.t('cli.hooks.noHook', { name: 'h' }, 'de')).toContain('kein Shell-Hook');
  });

  it('interpolates {vars} in both languages', () => {
    const en = i18n.t('cli.fallback.added', { id: 'a/b', pos: 2, file: '/c' }, 'en');
    expect(en).toContain('a/b');
    expect(en).toContain('position 2');
    expect(en).toContain('→ /c');
    expect(en.startsWith('✓')).toBe(true);

    const de = i18n.t('cli.fallback.added', { id: 'a/b', pos: 2, file: '/c' }, 'de');
    expect(de).toContain('a/b');
    expect(de).toContain('Position 2');
    expect(de).toContain('→ /c');
    expect(de).toContain('hinzugefügt');
    expect(de.startsWith('✓')).toBe(true);
    // German must differ from English (actually translated, not copied)
    expect(de).not.toBe(en);
  });

  it('falls back to English for an unknown locale, then to the key itself', () => {
    expect(i18n.t('app.name', {}, 'fr')).toBe('Mercury'); // en fallback
    expect(i18n.t('this.key.does.not.exist')).toBe('this.key.does.not.exist');
  });
});

describe('message-catalog key parity (en ↔ de)', () => {
  const en = new Set(leafKeys(readCatalog('en')));
  const de = new Set(leafKeys(readCatalog('de')));

  it('every English key has a German counterpart', () => {
    const missing = [...en].filter((k) => !de.has(k));
    expect(missing, `keys missing in de.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('every German key has an English counterpart (no orphan keys)', () => {
    const extra = [...de].filter((k) => !en.has(k));
    expect(extra, `keys missing in en.json: ${extra.join(', ')}`).toEqual([]);
  });

  it('has identical key counts and no empty German values', () => {
    expect(de.size).toBe(en.size);
    const cat = readCatalog('de');
    for (const k of leafKeys(cat)) {
      const v = k.split('.').reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], cat);
      expect(typeof v === 'string' && v.trim().length > 0, `empty German value for ${k}`).toBe(true);
    }
  });
});

describe('help-topic file parity (en ↔ de)', () => {
  const enTopics = new Set(readdirSync(helpDir).filter((f) => f.endsWith('.md')));
  const deTopics = new Set(readdirSync(join(helpDir, 'de')).filter((f) => f.endsWith('.md')));

  it('every English help topic has a German file', () => {
    const missing = [...enTopics].filter((f) => !deTopics.has(f));
    expect(missing, `German help topics missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('every German help topic has an English file (no orphans)', () => {
    const extra = [...deTopics].filter((f) => !enTopics.has(f));
    expect(extra, `orphan German help topics: ${extra.join(', ')}`).toEqual([]);
  });

  it('includes the new fallback and route topics in both languages', () => {
    for (const topic of ['fallback.md', 'route.md', 'hooks.md']) {
      expect(enTopics.has(topic), `missing en/${topic}`).toBe(true);
      expect(deTopics.has(topic), `missing de/${topic}`).toBe(true);
    }
  });
});
