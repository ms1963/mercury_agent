/**
 * Offline, deterministic tests for the WikiService (Karpathy's LLM-Wiki).
 *
 * - init / ingest / query use a TEST-LOCAL fake WikiLlm (no network, no mock provider
 *   in runtime — the fake lives only in this file, exactly as the no-mocks rule allows).
 * - Every deterministic lint check (orphan, broken-link, stub, stale, delta) runs with
 *   NO LLM at all: the service is constructed without an `llm`, and lint degrades to the
 *   deterministic checks. Only the contradiction check (one test) uses the fake llm.
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WikiService, type WikiLlm } from '@mercury/core';
import { readFile } from 'node:fs/promises';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mercury-wiki-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A deterministic fake LLM: one page per ingest, canned answer, configurable contradictions. */
function fakeLlm(over: Partial<WikiLlm> = {}): WikiLlm {
  return {
    synthesize: async (input) => [
      { slug: 'topic-a', title: 'Topic A', content: `Synthesised knowledge about topic A from ${input.sourceRef}. `.repeat(8), links: [] },
    ],
    answer: async (input) => `Answer drawn from ${input.pages.map((p) => p.slug).join(', ')}.`,
    detectContradictions: async () => [],
    ...over,
  };
}

/** Write a wiki page file directly (bypassing the LLM) for deterministic lint tests. */
function writePage(dir: string, p: { slug: string; title?: string; sources?: string[]; synthesized?: string; links?: string[]; body: string }): void {
  const fm = [
    '---',
    `title: ${p.title ?? p.slug}`,
    `slug: ${p.slug}`,
    `sources:${(p.sources ?? []).length ? '\n' + (p.sources ?? []).map((s) => `  - ${s}`).join('\n') : ' []'}`,
    `synthesized: ${p.synthesized ?? new Date().toISOString()}`,
    `links:${(p.links ?? []).length ? '\n' + (p.links ?? []).map((l) => `  - ${l}`).join('\n') : ' []'}`,
    '---',
    '',
    p.body,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'wiki', `${p.slug}.md`), fm, 'utf8');
}

const LONG = 'This page has plenty of real content so it is comfortably above the stub threshold. '.repeat(4);

describe('WikiService.init', () => {
  it('creates the directory layout and seeds schema/index/log', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir });
    await svc.init();
    expect((await readFile(join(dir, 'index.md'), 'utf8')).length).toBeGreaterThan(0);
    expect((await readFile(join(dir, 'log.md'), 'utf8')).length).toBeGreaterThan(0);
    expect((await readFile(join(dir, 'SCHEMA.md'), 'utf8'))).toContain('LLM Wiki');
    const status = await svc.status();
    expect(status.initialized).toBe(true);
    expect(status.pages).toBe(0);
  });
});

describe('WikiService.ingest', () => {
  it('stores the source immutably, writes a page, and updates the index + log', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm(), clock: () => new Date('2026-02-01T00:00:00.000Z') });
    const res = await svc.ingest('Raw notes about topic A.', { asText: true, name: 'notes.txt' });
    expect(res.created).toContain('topic-a');
    expect(res.source).toBe('raw/notes.txt');

    const page = await svc.readPage('topic-a');
    expect(page?.sources).toEqual(['raw/notes.txt']);
    expect(page?.synthesized).toBe('2026-02-01T00:00:00.000Z');

    const index = await readFile(join(dir, 'index.md'), 'utf8');
    expect(index).toContain('topic-a.md');
    const log = await readFile(join(dir, 'log.md'), 'utf8');
    expect(log).toContain('**ingest**');

    // Raw source is stored read-only (immutable).
    const mode = statSync(join(dir, 'raw', 'notes.txt')).mode;
    expect(mode & 0o200).toBe(0);
  });

  it('throws without an LLM backend', async () => {
    const svc = new WikiService({ dir: tmp() });
    await expect(svc.ingest('x', { asText: true })).rejects.toThrow(/LLM/);
  });

  it('re-ingesting the same slug UPDATES the page and accumulates its sources', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm() });
    const first = await svc.ingest('first notes', { asText: true, name: 'a.txt' });
    expect(first.created).toContain('topic-a');
    expect(first.updated).toEqual([]);

    const second = await svc.ingest('second notes', { asText: true, name: 'b.txt' });
    expect(second.updated).toContain('topic-a'); // same slug → update, not create
    expect(second.created).toEqual([]);

    const page = await svc.readPage('topic-a');
    // Both raw sources are now recorded on the page (sources accumulate).
    expect(page?.sources).toEqual(['raw/a.txt', 'raw/b.txt']);
  });

  it('ingests from a file path (not just literal text) and stores it immutably', async () => {
    const dir = tmp();
    const srcDir = tmp();
    const srcFile = join(srcDir, 'external.txt');
    writeFileSync(srcFile, 'knowledge from an external file', 'utf8');
    const svc = new WikiService({ dir, llm: fakeLlm() });
    const res = await svc.ingest(srcFile, {});
    expect(res.source).toBe('raw/external.txt');
    const mode = statSync(join(dir, 'raw', 'external.txt')).mode;
    expect(mode & 0o200).toBe(0); // read-only copy
  });

  it('rejects ingesting a non-existent file path', async () => {
    const svc = new WikiService({ dir: tmp(), llm: fakeLlm() });
    await expect(svc.ingest(join(tmp(), 'nope.txt'), {})).rejects.toThrow(/not found/);
  });

  it('gives a unique raw name when two sources share a filename', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm() });
    const r1 = await svc.ingest('one', { asText: true, name: 'dup.txt' });
    const r2 = await svc.ingest('two', { asText: true, name: 'dup.txt' });
    expect(r1.source).toBe('raw/dup.txt');
    expect(r2.source).toBe('raw/dup-1.txt'); // de-duplicated, original untouched
  });
});

describe('WikiService.query', () => {
  it('answers from the wiki and cites the underlying raw sources', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm() });
    await svc.ingest('Raw notes about topic A.', { asText: true, name: 'notes.txt' });
    const res = await svc.query('what about topic A?');
    expect(res.pages).toContain('topic-a');
    expect(res.sources).toContain('raw/notes.txt');
    expect(res.answer).toContain('topic-a');
  });

  it('returns a "no pages" answer when the wiki is empty', async () => {
    const svc = new WikiService({ dir: tmp(), llm: fakeLlm() });
    const res = await svc.query('anything?');
    expect(res.pages).toEqual([]);
    expect(res.sources).toEqual([]);
    expect(res.answer).toMatch(/no pages/i);
  });

  it('rejects an empty question and requires an LLM backend', async () => {
    const dir = tmp();
    await expect(new WikiService({ dir, llm: fakeLlm() }).query('   ')).rejects.toThrow(/non-empty/);
    await expect(new WikiService({ dir: tmp() }).query('hi')).rejects.toThrow(/LLM/);
  });

  it('coalesces identical concurrent queries into a single answer() call', async () => {
    const dir = tmp();
    let answerCalls = 0;
    const svc = new WikiService({
      dir,
      llm: fakeLlm({
        answer: async (input) => {
          answerCalls++;
          return `coalesced:${input.pages.map((p) => p.slug).join(',')}`;
        },
      }),
    });
    await svc.ingest('Raw notes about topic A.', { asText: true, name: 'notes.txt' });
    const [a, b] = await Promise.all([svc.query('topic A details'), svc.query('topic A details')]);
    expect(a).toEqual(b);
    expect(answerCalls).toBe(1); // both callers shared one in-flight synthesis
  });
});

describe('WikiService.status', () => {
  it('reports uninitialized before init, and page/source counts after ingest', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm() });
    expect((await svc.status()).initialized).toBe(false);
    await svc.ingest('Raw notes about topic A.', { asText: true, name: 'notes.txt' });
    const status = await svc.status();
    expect(status.initialized).toBe(true);
    expect(status.pages).toBe(1);
    expect(status.sources).toBe(1);
    expect(status.lastIngestAt).toBeTruthy();
  });
});

describe('WikiService.lint (deterministic, no LLM)', () => {
  it('flags orphan pages not linked from anywhere', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir });
    await svc.init();
    writeFileSync(join(dir, 'index.md'), '# Wiki Index\n\n- [Foo](wiki/foo.md)\n', 'utf8');
    writePage(dir, { slug: 'foo', body: LONG });
    writePage(dir, { slug: 'bar', body: LONG });
    const report = await svc.lint({ noLlm: true });
    expect(report.llmUsed).toBe(false);
    const orphans = report.issues.filter((i) => i.type === 'orphan').map((i) => i.page);
    expect(orphans).toContain('bar');
    expect(orphans).not.toContain('foo');
  });

  it('flags broken internal links', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir });
    await svc.init();
    writePage(dir, { slug: 'foo', body: `${LONG}\n\nSee [[ghost]] for more.` });
    const report = await svc.lint({ noLlm: true });
    const broken = report.issues.filter((i) => i.type === 'broken-link');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.related).toContain('ghost');
    expect(broken[0]!.severity).toBe('error');
  });

  it('flags stub pages (too short or placeholder markers)', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, stubMinChars: 50 });
    await svc.init();
    writePage(dir, { slug: 'tiny', body: 'too short' });
    writePage(dir, { slug: 'todo', body: `${LONG}\n\nTODO: finish this section.` });
    const report = await svc.lint({ noLlm: true });
    const stubs = report.issues.filter((i) => i.type === 'stub').map((i) => i.page);
    expect(stubs).toContain('tiny');
    expect(stubs).toContain('todo');
  });

  it('flags stale pages whose raw source is newer than the last synthesis', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir });
    await svc.init();
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(join(dir, 'raw', 'src.txt'), 'updated source', 'utf8');
    // Source modified "now"; page synthesised long ago → stale.
    writePage(dir, { slug: 'foo', body: LONG, sources: ['raw/src.txt'], synthesized: '2020-01-01T00:00:00.000Z' });
    const report = await svc.lint({ noLlm: true });
    const stale = report.issues.filter((i) => i.type === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.related).toContain('raw/src.txt');
  });

  it('delta mode only checks pages touched since the last lint', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir });
    await svc.init();
    writeFileSync(join(dir, 'index.md'), '# Wiki Index\n\n- [A](wiki/a.md)\n- [B](wiki/b.md)\n', 'utf8');
    writePage(dir, { slug: 'a', body: LONG });
    writePage(dir, { slug: 'b', body: LONG });

    const first = await svc.lint({ noLlm: true });
    expect(first.checkedPages).toBe(2);
    expect(first.delta).toBe(false);

    // Make page A clearly newer and page B clearly older than the just-recorded lint time.
    const now = Date.now();
    utimesSync(join(dir, 'wiki', 'a.md'), new Date(now + 3_600_000), new Date(now + 3_600_000));
    utimesSync(join(dir, 'wiki', 'b.md'), new Date(now - 3_600_000), new Date(now - 3_600_000));

    const delta = await svc.lint({ delta: true, noLlm: true });
    expect(delta.delta).toBe(true);
    expect(delta.totalPages).toBe(2);
    expect(delta.checkedPages).toBe(1);
  });
});

describe('WikiService.lint (LLM contradiction check)', () => {
  it('reports contradictions from the injected LLM and marks llmUsed', async () => {
    const dir = tmp();
    const svc = new WikiService({
      dir,
      llm: fakeLlm({ detectContradictions: async () => [{ pages: ['a', 'b'], detail: 'A says X, B says not-X.' }] }),
    });
    await svc.init();
    writePage(dir, { slug: 'a', body: LONG, links: ['b'] });
    writePage(dir, { slug: 'b', body: LONG, links: ['a'] });
    const report = await svc.lint({});
    expect(report.llmUsed).toBe(true);
    const contradictions = report.issues.filter((i) => i.type === 'contradiction');
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.related).toEqual(['a', 'b']);
  });

  it('skips the contradiction check when noLlm is set even if an LLM is present', async () => {
    const dir = tmp();
    const svc = new WikiService({ dir, llm: fakeLlm({ detectContradictions: async () => [{ pages: ['a', 'b'], detail: 'x' }] }) });
    await svc.init();
    writePage(dir, { slug: 'a', body: LONG, links: ['b'] });
    writePage(dir, { slug: 'b', body: LONG, links: ['a'] });
    const report = await svc.lint({ noLlm: true });
    expect(report.llmUsed).toBe(false);
    expect(report.issues.filter((i) => i.type === 'contradiction')).toHaveLength(0);
  });
});
