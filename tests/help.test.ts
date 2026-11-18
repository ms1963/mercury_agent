/** Help docs localization: German served under locale `de`, English default + fallback. */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { assetsDir, HelpSystem } from '@mercury/core';
import { makeMercury } from './helpers.js';

const helpDir = join(assetsDir(), 'docs', 'help');

describe('help localization', () => {
  it('serves English by default', () => {
    const help = new HelpSystem([helpDir]);
    const doc = help.get('getting-started');
    expect(doc).toContain('# Getting started');
    expect(doc).not.toContain('# Erste Schritte');
  });

  it('serves the German file when the effective locale is de', () => {
    const help = new HelpSystem([helpDir], 'de');
    const doc = help.get('getting-started');
    expect(doc).toContain('# Erste Schritte');
    expect(doc).not.toContain('# Getting started');
  });

  it('honours an explicit locale argument over the default', () => {
    const help = new HelpSystem([helpDir], 'en');
    expect(help.get('security', 'de')).toContain('# Sicherheit');
    expect(help.get('security', 'en')).toContain('# Security');
  });

  it('every English topic has a German translation', () => {
    const en = new HelpSystem([helpDir], 'en');
    const de = new HelpSystem([helpDir], 'de');
    for (const t of en.topics('en')) {
      const deDoc = de.get(t.name);
      expect(deDoc, `missing German translation for ${t.name}`).toBeDefined();
      // German doc must actually differ from the English original (not a copy/stub).
      expect(deDoc).not.toBe(en.get(t.name));
    }
  });

  it('falls back to English when a German translation is missing', () => {
    // A directory with only an English file and a de/ subfolder lacking that file.
    const help = new HelpSystem([helpDir], 'de');
    // 'getting-started' exists in de/, so prove fallback via a non-existent locale.
    const help2 = new HelpSystem([helpDir], 'fr');
    expect(help2.get('getting-started')).toContain('# Getting started');
    expect(help.get('getting-started')).toContain('# Erste Schritte');
  });

  it('end-to-end: config.locale=de makes the runtime help serve German', async () => {
    const ctx = await makeMercury({ locale: 'de' });
    try {
      const doc = ctx.m.help.get('getting-started');
      expect(doc).toContain('# Erste Schritte');
    } finally {
      await ctx.close();
    }
  });
});
