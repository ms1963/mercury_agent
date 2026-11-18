/**
 * LLM-Wiki tools (toolset "wiki"). Karpathy's ingestion-time synthesis pattern:
 * - wiki_ingest: synthesise/update cross-linked wiki pages from a new source
 * - wiki_query:  answer a question grounded in the wiki, citing raw sources
 * - wiki_lint:   quality checks (orphans, broken links, stubs, staleness, contradictions)
 *
 * All three delegate to the runtime WikiService (ctx.services.wiki), which uses the
 * real LLM service for synthesis/answering/contradiction-detection.
 */
import { defineTool, type AnyTool, type ToolContext } from '@mercury/core';
import { bool, num, params, str } from '../util.js';
import { resolvePath } from '../util.js';

function wikiOf(ctx: ToolContext) {
  const wiki = ctx.services.wiki;
  if (!wiki) throw new Error('The wiki subsystem is disabled (set wiki.enabled=true in config).');
  return wiki;
}

export const wikiIngest = defineTool<{ text?: string; path?: string; name?: string; instruction?: string }>({
  name: 'wiki_ingest',
  description:
    'Ingest a source into the LLM Wiki: the source is stored immutably under raw/, then the LLM synthesises or updates cross-linked markdown pages and the index. Provide either text (literal content) or path (a file to read). Optionally name the stored source and give synthesis guidance.',
  toolset: 'wiki',
  risk: 'moderate',
  parameters: params(
    { text: str('Literal source text to ingest'), path: str('Path to a source file to ingest (inside the path jail)'), name: str('Filename to store the source under in raw/'), instruction: str('Optional guidance for how to synthesise the page(s)') },
    [],
  ),
  async execute(a, ctx) {
    const wiki = wikiOf(ctx);
    let res;
    if (a.text != null && a.text.length) {
      res = await wiki.ingest(a.text, { asText: true, name: a.name, instruction: a.instruction });
    } else if (a.path) {
      res = await wiki.ingest(resolvePath(ctx, a.path), { name: a.name, instruction: a.instruction });
    } else {
      return { content: 'Provide either text or path to ingest.', isError: true };
    }
    ctx.emit('wiki.ingest', { source: res.source, created: res.created.length, updated: res.updated.length });
    const parts = [`Ingested ${res.source}.`];
    if (res.created.length) parts.push(`Created: ${res.created.join(', ')}.`);
    if (res.updated.length) parts.push(`Updated: ${res.updated.join(', ')}.`);
    return { content: parts.join(' '), data: res };
  },
});

export const wikiQuery = defineTool<{ question: string; k?: number }>({
  name: 'wiki_query',
  description: 'Answer a question from the LLM Wiki: consults the index, reads the most relevant pages and answers, citing the underlying raw source files.',
  toolset: 'wiki',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ question: str('The question to answer from the wiki'), k: num('Max pages to consult (default 6)') }, ['question']),
  async execute(a, ctx) {
    const wiki = wikiOf(ctx);
    const res = await wiki.query(a.question, { k: a.k });
    const cites = res.sources.length ? `\n\nSources: ${res.sources.join(', ')}` : '';
    const pages = res.pages.length ? `\nPages: ${res.pages.join(', ')}` : '';
    return { content: `${res.answer}${cites}${pages}`, data: res };
  },
});

export const wikiLint = defineTool<{ delta?: boolean; no_llm?: boolean }>({
  name: 'wiki_lint',
  description:
    'Run quality checks over the LLM Wiki: orphan pages, broken internal links, stub/gap pages, stale pages (a raw source newer than the page) and (LLM-assisted) contradictions. delta only checks pages touched since the last lint; no_llm skips the contradiction check.',
  toolset: 'wiki',
  risk: 'safe',
  parameters: params({ delta: bool('Only check pages changed since the last lint'), no_llm: bool('Skip the LLM contradiction check') }, []),
  async execute(a, ctx) {
    const wiki = wikiOf(ctx);
    const report = await wiki.lint({ delta: a.delta, noLlm: a.no_llm });
    if (!report.issues.length) {
      return { content: `No issues. Checked ${report.checkedPages}/${report.totalPages} page(s)${report.delta ? ' (delta)' : ''}; contradiction check ${report.llmUsed ? 'ran' : 'skipped'}.`, data: report };
    }
    const byType = new Map<string, string[]>();
    for (const i of report.issues) {
      const list = byType.get(i.type) ?? [];
      list.push(`${i.page ? `[${i.page}] ` : ''}${i.detail}`);
      byType.set(i.type, list);
    }
    const sections = [...byType.entries()].map(([type, items]) => `${type} (${items.length}):\n  - ${items.join('\n  - ')}`);
    return { content: `${report.issues.length} issue(s) across ${report.checkedPages}/${report.totalPages} page(s):\n\n${sections.join('\n\n')}`, data: report };
  },
});

export const wikiTools: AnyTool[] = [wikiIngest, wikiQuery, wikiLint];
