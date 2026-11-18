/**
 * WikiService — Karpathy's "LLM Wiki" pattern as a first-class Mercury feature.
 *
 * Instead of query-time RAG, the LLM synthesises knowledge into a human-readable,
 * cross-linked markdown wiki at INGESTION time. On-disk layout (under `dir`):
 *
 *   raw/        immutable original sources (read-only; read, never modified)
 *   wiki/       LLM-authored markdown pages with YAML frontmatter, cross-linked
 *   index.md    table of contents / entry points (maintained deterministically)
 *   log.md      append-only log of ingest/lint operations
 *   SCHEMA.md   page conventions / schema
 *   .wiki-state.json  small state file (last-lint marker)
 *
 * Three operations: ingest, query, lint (with delta-lint). All LLM work is injected
 * as a `WikiLlm` so the runtime wires the real LLMService (inheriting its
 * circuit-breaker + retry) while tests inject a deterministic implementation — no
 * mock provider ever runs in production paths.
 */
import { constants as FS } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { SingleFlight, TtlCache } from '../reliability/index.js';

/** Input handed to the LLM to synthesise/update wiki pages for one new source. */
export interface WikiSynthesisInput {
  /** Path of the source relative to the wiki dir, e.g. "raw/notes.txt". */
  sourceRef: string;
  sourceText: string;
  /** Existing wiki pages, so the model can update them and add cross-links. */
  existingPages: WikiPageView[];
  /** Optional caller guidance. */
  instruction?: string;
}

/** A page the LLM asks the service to write/update. Body is markdown (no frontmatter). */
export interface WikiSynthesizedPage {
  slug: string;
  title: string;
  content: string;
  /** Outgoing links (slugs of other pages). */
  links?: string[];
}

export interface WikiAnswerInput {
  question: string;
  pages: WikiPageView[];
}

export interface WikiContradictionInput {
  pages: WikiPageView[];
}

export interface WikiContradiction {
  /** Slugs of the pages that contradict each other. */
  pages: string[];
  detail: string;
}

/** LLM operations the wiki needs. Injected: real LLMService in runtime, fake in tests. */
export interface WikiLlm {
  synthesize(input: WikiSynthesisInput): Promise<WikiSynthesizedPage[]>;
  answer(input: WikiAnswerInput): Promise<string>;
  detectContradictions(input: WikiContradictionInput): Promise<WikiContradiction[]>;
}

export interface WikiServiceOptions {
  /** Root directory of the wiki (raw/, wiki/, index.md, ...). */
  dir: string;
  /** Schema/convention file name under `dir` (default "SCHEMA.md"). */
  schemaFile?: string;
  /** Pages shorter than this (body chars) are flagged as stubs (default 200). */
  stubMinChars?: number;
  /** LLM backend. Optional: ingest/query require it; lint degrades without it. */
  llm?: WikiLlm;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
}

/** A parsed wiki page. */
export interface WikiPage {
  slug: string;
  title: string;
  /** Source refs recorded in frontmatter, relative to the wiki dir. */
  sources: string[];
  /** ISO timestamp of the last synthesis. */
  synthesized: string;
  /** Declared outgoing links (slugs). */
  links: string[];
  /** Markdown body (frontmatter stripped). */
  body: string;
  /** Absolute path of the page file. */
  path: string;
  /** File mtime in ms (used by delta-lint). */
  mtimeMs: number;
}

/** A lighter view passed to the LLM (no fs metadata). */
export interface WikiPageView {
  slug: string;
  title: string;
  sources: string[];
  content: string;
}

export interface WikiIngestResult {
  source: string;
  pages: string[];
  created: string[];
  updated: string[];
}

export interface WikiQueryResult {
  answer: string;
  /** Slugs of the wiki pages consulted. */
  pages: string[];
  /** Underlying raw source files cited. */
  sources: string[];
}

export type WikiIssueType = 'orphan' | 'broken-link' | 'stub' | 'stale' | 'contradiction';
export type WikiSeverity = 'error' | 'warning' | 'info';

export interface WikiLintIssue {
  type: WikiIssueType;
  severity: WikiSeverity;
  /** Slug of the page the issue is about (if page-scoped). */
  page?: string;
  detail: string;
  /** Other slugs/sources involved. */
  related?: string[];
}

export interface WikiLintReport {
  issues: WikiLintIssue[];
  checkedPages: number;
  totalPages: number;
  delta: boolean;
  /** Whether the LLM contradiction check actually ran. */
  llmUsed: boolean;
  ranAt: string;
  previousLintAt?: string;
}

export interface WikiStatus {
  dir: string;
  initialized: boolean;
  pages: number;
  sources: number;
  lastLintAt?: string;
  lastIngestAt?: string;
}

interface WikiState {
  lastLintAt?: string;
  lastIngestAt?: string;
}

const STATE_FILE = '.wiki-state.json';

export class WikiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiError';
  }
}

export class WikiService {
  readonly dir: string;
  private readonly rawDir: string;
  private readonly wikiDir: string;
  private readonly indexPath: string;
  private readonly logPath: string;
  private readonly schemaName: string;
  private readonly schemaPath: string;
  private readonly statePath: string;
  private readonly stubMinChars: number;
  private readonly llm?: WikiLlm;
  private readonly now: () => Date;
  private initialized = false;
  /** Coalesces identical concurrent queries. */
  private readonly queryFlight = new SingleFlight<string, WikiQueryResult>();
  /** Caches the parsed index keyed by its mtime, so repeated queries skip re-parsing. */
  private readonly indexCache = new TtlCache<string, WikiIndexEntry[]>({ ttlMs: 30_000, maxSize: 4 });

  constructor(options: WikiServiceOptions) {
    this.dir = options.dir;
    this.rawDir = join(this.dir, 'raw');
    this.wikiDir = join(this.dir, 'wiki');
    this.indexPath = join(this.dir, 'index.md');
    this.logPath = join(this.dir, 'log.md');
    this.schemaName = options.schemaFile ?? 'SCHEMA.md';
    this.schemaPath = join(this.dir, this.schemaName);
    this.statePath = join(this.dir, STATE_FILE);
    this.stubMinChars = options.stubMinChars ?? 200;
    this.llm = options.llm;
    this.now = options.clock ?? (() => new Date());
  }

  /** Lazily create the directory structure and seed schema/index/log if absent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rawDir, { recursive: true });
    await mkdir(this.wikiDir, { recursive: true });
    if (!(await exists(this.schemaPath))) await writeFile(this.schemaPath, DEFAULT_SCHEMA, 'utf8');
    if (!(await exists(this.indexPath))) await writeFile(this.indexPath, SEED_INDEX, 'utf8');
    if (!(await exists(this.logPath))) await writeFile(this.logPath, SEED_LOG, 'utf8');
    this.initialized = true;
  }

  /**
   * Ingest a new source: copy/write it immutably into raw/, synthesise or update
   * wiki pages via the LLM, maintain cross-links + index.md, and append to log.md.
   *
   * @param sourcePathOrText a filesystem path, or (with opts.asText) the literal text.
   */
  async ingest(sourcePathOrText: string, opts: { asText?: boolean; name?: string; instruction?: string } = {}): Promise<WikiIngestResult> {
    await this.init();
    if (!this.llm) throw new WikiError('ingest requires an LLM backend (no provider configured)');

    const { ref, text } = await this.importSource(sourcePathOrText, opts);
    const existingPages = (await this.readPages()).map(toView);
    const synthesized = await this.llm.synthesize({ sourceRef: ref, sourceText: text, existingPages, instruction: opts.instruction });
    if (!synthesized.length) throw new WikiError('synthesis produced no pages');

    const existingSlugs = new Set(existingPages.map((p) => p.slug));
    const created: string[] = [];
    const updated: string[] = [];
    for (const page of synthesized) {
      const slug = normalizeSlug(page.slug);
      if (!slug) throw new WikiError(`synthesised page has an invalid slug: ${JSON.stringify(page.slug)}`);
      const prior = existingSlugs.has(slug) ? await this.readPage(slug) : undefined;
      // A page carries every source that contributed to it: prior sources + this one.
      const sources = unique([...(prior?.sources ?? []), ref]);
      const links = unique((page.links ?? []).map(normalizeSlug).filter(Boolean));
      await this.writePage({ slug, title: page.title || slug, sources, synthesized: this.nowIso(), links, body: page.content.trim() });
      (prior ? updated : created).push(slug);
    }

    await this.rebuildIndex();
    await this.appendLog('ingest', `source=${ref} pages=${synthesized.map((p) => normalizeSlug(p.slug)).join(',')} created=${created.length} updated=${updated.length}`);
    await this.patchState({ lastIngestAt: this.nowIso() });
    return { source: ref, pages: synthesized.map((p) => normalizeSlug(p.slug)), created, updated };
  }

  /**
   * Answer a question grounded in the wiki: consult index.md to locate candidate
   * pages, read them, and have the LLM answer citing the underlying raw sources.
   * Identical concurrent queries are coalesced via SingleFlight.
   */
  async query(question: string, opts: { k?: number } = {}): Promise<WikiQueryResult> {
    await this.init();
    if (!this.llm) throw new WikiError('query requires an LLM backend (no provider configured)');
    const q = question.trim();
    if (!q) throw new WikiError('query requires a non-empty question');
    const key = `${opts.k ?? 6}::${q}`;
    return this.queryFlight.run(key, async () => {
      const index = await this.loadIndex();
      const candidates = await this.selectCandidates(index, q, opts.k ?? 6);
      if (!candidates.length) {
        return { answer: 'The wiki has no pages yet; nothing to answer from.', pages: [], sources: [] };
      }
      const answer = await this.llm!.answer({ question: q, pages: candidates.map(toView) });
      const sources = unique(candidates.flatMap((p) => p.sources));
      return { answer, pages: candidates.map((p) => p.slug), sources };
    });
  }

  /**
   * Quality checks over the wiki. The deterministic checks (orphans, broken links,
   * stubs, staleness) never call the LLM. Contradiction detection is LLM-assisted
   * and skipped when opts.noLlm is set or no provider is configured.
   *
   * delta mode only checks pages created/modified since the last recorded lint pass.
   */
  async lint(opts: { delta?: boolean; noLlm?: boolean } = {}): Promise<WikiLintReport> {
    await this.init();
    const ranAt = this.nowIso();
    const state = await this.readState();
    const previousLintAt = state.lastLintAt;
    const allPages = await this.readPages();
    const index = await this.loadIndex();

    const lastLintMs = opts.delta && previousLintAt ? Date.parse(previousLintAt) : undefined;
    const targetPages = lastLintMs !== undefined ? allPages.filter((p) => p.mtimeMs > lastLintMs) : allPages;

    const issues: WikiLintIssue[] = [];
    const knownSlugs = new Set(allPages.map((p) => p.slug));
    // Pages that link TO each slug (from the index or any page body/frontmatter).
    const inbound = this.buildInboundLinks(allPages, index);

    for (const page of targetPages) {
      // (a) Orphan: nothing links to it (and it is not the only page).
      if (allPages.length > 1 && (inbound.get(page.slug)?.size ?? 0) === 0) {
        issues.push({ type: 'orphan', severity: 'warning', page: page.slug, detail: `Page "${page.slug}" is not linked from index.md or any other page.` });
      }
      // (b) Broken internal links: declared/body links to non-existent pages.
      for (const target of this.outboundLinks(page)) {
        if (!knownSlugs.has(target)) issues.push({ type: 'broken-link', severity: 'error', page: page.slug, detail: `Link to "${target}" points to a page that does not exist.`, related: [target] });
      }
      // (c) Stub / gap pages: too short or placeholder markers.
      const stub = this.stubReason(page);
      if (stub) issues.push({ type: 'stub', severity: 'warning', page: page.slug, detail: stub });
      // (d) Stale claims: a raw source is newer than the page's synthesis time.
      for (const stale of await this.staleSources(page)) {
        issues.push({ type: 'stale', severity: 'warning', page: page.slug, detail: `Source "${stale}" was modified after the page was last synthesised (${page.synthesized}).`, related: [stale] });
      }
    }

    // (e) Contradictions — LLM-assisted, skippable, never via a mock in runtime.
    let llmUsed = false;
    const canLlm = !opts.noLlm && !!this.llm && targetPages.length > 1;
    if (canLlm) {
      llmUsed = true;
      const found = await this.llm!.detectContradictions({ pages: targetPages.map(toView) });
      for (const c of found) issues.push({ type: 'contradiction', severity: 'error', page: c.pages[0], detail: c.detail, related: c.pages });
    }

    await this.appendLog('lint', `delta=${!!opts.delta} checked=${targetPages.length}/${allPages.length} issues=${issues.length} llm=${llmUsed}`);
    await this.patchState({ lastLintAt: ranAt });
    return { issues, checkedPages: targetPages.length, totalPages: allPages.length, delta: !!opts.delta, llmUsed, ranAt, previousLintAt };
  }

  /** Lightweight status for the CLI. */
  async status(): Promise<WikiStatus> {
    const initialized = (await exists(this.indexPath)) && (await exists(this.wikiDir));
    if (!initialized) return { dir: this.dir, initialized: false, pages: 0, sources: 0 };
    const pages = await this.readPages();
    const sources = (await this.listRaw()).length;
    const state = await this.readState();
    return { dir: this.dir, initialized: true, pages: pages.length, sources, lastLintAt: state.lastLintAt, lastIngestAt: state.lastIngestAt };
  }

  // ---- internals -----------------------------------------------------------

  /** Copy a file (or write literal text) into raw/ under a unique, immutable name. */
  private async importSource(sourcePathOrText: string, opts: { asText?: boolean; name?: string }): Promise<{ ref: string; text: string }> {
    if (opts.asText) {
      const name = await this.uniqueRawName(opts.name ?? 'note.md');
      const dest = join(this.rawDir, name);
      await writeFile(dest, sourcePathOrText, 'utf8');
      await chmod(dest, 0o444).catch(() => undefined);
      return { ref: `raw/${name}`, text: sourcePathOrText };
    }
    if (!(await exists(sourcePathOrText))) throw new WikiError(`source file not found: ${sourcePathOrText}`);
    const text = await readFile(sourcePathOrText, 'utf8');
    const name = await this.uniqueRawName(opts.name ?? basename(sourcePathOrText));
    const dest = join(this.rawDir, name);
    await copyFile(sourcePathOrText, dest);
    await chmod(dest, 0o444).catch(() => undefined);
    return { ref: `raw/${name}`, text };
  }

  /** Pick a raw/ filename that does not collide with an existing (immutable) source. */
  private async uniqueRawName(desired: string): Promise<string> {
    const safe = desired.replace(/[^\w.\- ]+/g, '_').trim() || 'source';
    if (!(await exists(join(this.rawDir, safe)))) return safe;
    const ext = extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    for (let i = 1; ; i++) {
      const candidate = `${stem}-${i}${ext}`;
      if (!(await exists(join(this.rawDir, candidate)))) return candidate;
    }
  }

  private async writePage(page: Omit<WikiPage, 'path' | 'mtimeMs'>): Promise<void> {
    const frontmatter = YAML.stringify({ title: page.title, slug: page.slug, sources: page.sources, synthesized: page.synthesized, links: page.links }).trimEnd();
    const content = `---\n${frontmatter}\n---\n\n${page.body}\n`;
    await writeFile(join(this.wikiDir, `${page.slug}.md`), content, 'utf8');
  }

  async readPage(slug: string): Promise<WikiPage | undefined> {
    const path = join(this.wikiDir, `${normalizeSlug(slug)}.md`);
    if (!(await exists(path))) return undefined;
    const raw = await readFile(path, 'utf8');
    const st = await stat(path);
    return parsePage(normalizeSlug(slug), raw, path, st.mtimeMs);
  }

  async readPages(): Promise<WikiPage[]> {
    if (!(await exists(this.wikiDir))) return [];
    const files = (await readdir(this.wikiDir)).filter((f) => f.endsWith('.md')).sort();
    const pages: WikiPage[] = [];
    for (const f of files) {
      const slug = f.slice(0, -3);
      const page = await this.readPage(slug);
      if (page) pages.push(page);
    }
    return pages;
  }

  private async listRaw(): Promise<string[]> {
    if (!(await exists(this.rawDir))) return [];
    return (await readdir(this.rawDir)).sort();
  }

  /** Regenerate index.md as a deterministic, parseable table of contents. */
  private async rebuildIndex(): Promise<void> {
    const pages = await this.readPages();
    const lines = ['# Wiki Index', '', `_${pages.length} page${pages.length === 1 ? '' : 's'}. Maintained automatically on ingest._`, ''];
    for (const p of pages) lines.push(`- [${p.title}](wiki/${p.slug}.md)`);
    lines.push('');
    await writeFile(this.indexPath, lines.join('\n'), 'utf8');
    this.indexCache.clear();
  }

  /** Parse index.md into entries, cached by index-file mtime. */
  private async loadIndex(): Promise<WikiIndexEntry[]> {
    if (!(await exists(this.indexPath))) return [];
    const st = await stat(this.indexPath);
    const cacheKey = String(st.mtimeMs);
    const cached = this.indexCache.get(cacheKey);
    if (cached) return cached;
    const raw = await readFile(this.indexPath, 'utf8');
    const entries = parseIndex(raw);
    this.indexCache.set(cacheKey, entries);
    return entries;
  }

  /** Rank pages against the question (keyword overlap on title+slug+body) and read the top K. */
  private async selectCandidates(index: WikiIndexEntry[], question: string, k: number): Promise<WikiPage[]> {
    const pages = await this.readPages();
    if (!pages.length) return [];
    const indexed = new Set(index.map((e) => e.slug));
    const terms = tokenize(question);
    const scored = pages.map((p) => {
      const hay = tokenize(`${p.title} ${p.slug} ${p.body}`);
      let score = 0;
      for (const t of terms) if (hay.has(t)) score++;
      // Prefer pages reachable from the index (true entry points).
      if (indexed.has(p.slug)) score += 0.5;
      return { page: p, score };
    });
    const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const chosen = (matched.length ? matched : scored).slice(0, Math.max(1, k));
    return chosen.map((s) => s.page);
  }

  /** Map slug -> set of slugs/sources that link to it (index entries + page links). */
  private buildInboundLinks(pages: WikiPage[], index: WikiIndexEntry[]): Map<string, Set<string>> {
    const inbound = new Map<string, Set<string>>();
    const add = (target: string, from: string) => {
      const set = inbound.get(target) ?? new Set<string>();
      set.add(from);
      inbound.set(target, set);
    };
    for (const e of index) add(e.slug, 'index');
    for (const p of pages) for (const target of this.outboundLinks(p)) add(target, p.slug);
    return inbound;
  }

  /** Outgoing links of a page: frontmatter `links` plus links found in the body. */
  private outboundLinks(page: WikiPage): Set<string> {
    const out = new Set<string>();
    for (const l of page.links) if (l !== page.slug) out.add(l);
    for (const l of extractBodyLinks(page.body)) if (l !== page.slug) out.add(l);
    return out;
  }

  private stubReason(page: WikiPage): string | undefined {
    const body = page.body.trim();
    if (body.length < this.stubMinChars) return `Page "${page.slug}" is only ${body.length} chars (< ${this.stubMinChars}); looks like a stub.`;
    if (/\b(TODO|TBD|FIXME|WIP|placeholder|coming soon)\b/i.test(body)) return `Page "${page.slug}" contains a placeholder marker (TODO/TBD/…).`;
    return undefined;
  }

  private async staleSources(page: WikiPage): Promise<string[]> {
    const synthMs = Date.parse(page.synthesized);
    if (Number.isNaN(synthMs)) return [];
    const stale: string[] = [];
    for (const ref of page.sources) {
      const abs = join(this.dir, ref);
      if (!(await exists(abs))) continue;
      const st = await stat(abs);
      if (st.mtimeMs > synthMs) stale.push(ref);
    }
    return stale;
  }

  private async appendLog(op: string, detail: string): Promise<void> {
    const line = `- ${this.nowIso()} **${op}** ${detail}\n`;
    const prev = (await exists(this.logPath)) ? await readFile(this.logPath, 'utf8') : SEED_LOG;
    await writeFile(this.logPath, prev.endsWith('\n') ? prev + line : `${prev}\n${line}`, 'utf8');
  }

  private async readState(): Promise<WikiState> {
    if (!(await exists(this.statePath))) return {};
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as WikiState;
    } catch {
      return {};
    }
  }

  private async patchState(patch: Partial<WikiState>): Promise<void> {
    const next = { ...(await this.readState()), ...patch };
    await writeFile(this.statePath, JSON.stringify(next, null, 2), 'utf8');
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

interface WikiIndexEntry {
  title: string;
  slug: string;
}

// ---- pure helpers ----------------------------------------------------------

function toView(p: WikiPage): WikiPageView {
  return { slug: p.slug, title: p.title, sources: p.sources, content: p.body };
}

export function normalizeSlug(slug: string): string {
  return String(slug ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/^.*\//, '')
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises');
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Split a frontmatter+body markdown file into a WikiPage. */
export function parsePage(slug: string, raw: string, path: string, mtimeMs: number): WikiPage {
  let data: Record<string, unknown> = {};
  let body = raw;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (m) {
    try {
      data = (YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
    } catch {
      data = {};
    }
    body = raw.slice(m[0].length);
  }
  const sources = Array.isArray(data.sources) ? (data.sources as unknown[]).map(String) : [];
  const links = Array.isArray(data.links) ? (data.links as unknown[]).map((l) => normalizeSlug(String(l))).filter(Boolean) : [];
  return {
    slug,
    title: typeof data.title === 'string' && data.title ? data.title : slug,
    sources,
    synthesized: typeof data.synthesized === 'string' ? data.synthesized : '',
    links,
    body: body.replace(/^\n+/, ''),
    path,
    mtimeMs,
  };
}

/** Parse index.md markdown links to `wiki/<slug>.md` (or `<slug>.md`) into entries. */
export function parseIndex(raw: string): WikiIndexEntry[] {
  const entries: WikiIndexEntry[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const href = m[2]!.trim();
    const fileMatch = /(?:^|\/)([\w\- ]+)\.md$/i.exec(href);
    if (!fileMatch) continue;
    const slug = normalizeSlug(fileMatch[1]!);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ title: m[1]!, slug });
  }
  return entries;
}

/** Extract internal links from a page body: `[t](slug.md)`, `[t](wiki/slug.md)` and `[[slug]]`. */
export function extractBodyLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1]!.trim();
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#')) continue; // external / anchor
    const fileMatch = /(?:^|\/)([\w\- ]+)\.md(?:#.*)?$/i.exec(href);
    if (fileMatch) out.add(normalizeSlug(fileMatch[1]!));
  }
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const slug = normalizeSlug(m[1]!);
    if (slug) out.add(slug);
  }
  return [...out];
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

const DEFAULT_SCHEMA = `# Wiki Schema & Conventions

This directory is an **LLM Wiki** (Karpathy's ingestion-time synthesis pattern). The LLM
reads sources and writes human-readable, cross-linked knowledge pages.

## Layout
- \`raw/\`   — immutable original sources. Read, never modified.
- \`wiki/\`  — LLM-authored markdown pages (one topic per file, \`<slug>.md\`).
- \`index.md\` — table of contents (regenerated automatically on ingest).
- \`log.md\` — append-only record of ingest and lint operations.

## Page format
Every wiki page starts with YAML frontmatter:

\`\`\`yaml
---
title: Human readable title
slug: kebab-case-slug
sources:
  - raw/original-source.txt
synthesized: 2026-01-01T00:00:00.000Z
links:
  - another-slug
---
\`\`\`

Followed by markdown prose. Cross-link other pages with \`[Title](other-slug.md)\`
or \`[[other-slug]]\`. Keep each page focused; split large topics into linked pages.

## Conventions
- Prefer several focused pages over one sprawling page.
- Always cite which raw source a claim comes from.
- Keep pages above the stub threshold; a near-empty page is a gap to fill.
`;

const SEED_INDEX = `# Wiki Index

_No pages yet. Ingest a source to get started._
`;

const SEED_LOG = `# Wiki Log

Append-only log of ingest and lint operations.
`;
