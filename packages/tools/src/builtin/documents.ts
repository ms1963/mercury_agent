/**
 * Document-generation tools (toolset "data"): turn Markdown/HTML source or structured data into
 * real files (PDF, Word .docx, HTML, PowerPoint .pptx, Markdown, Excel .xlsx) and return them as
 * attachments so they are sent back to the user — mirroring media.ts's image_generate / text_to_speech.
 *
 * No npm dependencies are added: generation uses the host `pandoc` (md/html → docx/pptx/html/pdf),
 * `libreoffice`/`soffice` (reliable PDF without a LaTeX engine) and `zip` (hand-written OOXML for
 * spreadsheets), exactly like the pdftotext/unzip extraction path. Every tool degrades gracefully
 * with a clear "install …" message when no engine is available.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type AnyTool } from '@mercury/core';
import { runArgv } from '../terminal/backends.js';
import { arr, params, str, strEnum } from '../util.js';

const OUT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  md: 'text/markdown',
};

/** True when `bin` is on PATH (POSIX `command -v`). */
async function hasBin(bin: string): Promise<boolean> {
  const r = await runArgv(['sh', '-c', `command -v ${bin}`], { cwd: tmpdir(), timeoutMs: 5_000 });
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

/** First available binary name from `candidates`, or undefined. */
async function firstBin(candidates: string[]): Promise<string | undefined> {
  for (const b of candidates) if (await hasBin(b)) return b;
  return undefined;
}

/** Make an isolated scratch directory for one generation run. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mercury-doc-'));
}

// ---------------------------------------------------------------------------
// document_generate — Markdown / HTML → PDF / DOCX / HTML / PPTX / MD
// ---------------------------------------------------------------------------

/** Run pandoc; returns {ok,msg}. Degrades to a clear message when pandoc is missing. */
async function pandoc(argv: string[], cwd: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await hasBin('pandoc'))) return { ok: false, msg: 'install pandoc to generate documents (https://pandoc.org/installing.html)' };
  const r = await runArgv(['pandoc', ...argv], { cwd, timeoutMs: 120_000 });
  return { ok: r.exitCode === 0, msg: (r.stderr || r.stdout).trim() || `pandoc exited ${r.exitCode}` };
}

/**
 * Convert markdown/html → pdf. Prefers libreoffice (reliable, no LaTeX engine needed): pandoc
 * builds an intermediate .docx, then soffice converts it to PDF. Falls back to a pandoc PDF engine
 * (weasyprint/wkhtmltopdf/latex) when libreoffice is absent.
 */
async function toPdf(dir: string, inFile: string, from: string): Promise<{ buf?: Buffer; error?: string }> {
  const soffice = await firstBin(['libreoffice', 'soffice']);
  if (soffice) {
    const docx = join(dir, 'intermediate.docx');
    const p = await pandoc(['-f', from, '-t', 'docx', inFile, '-o', docx], dir);
    if (!p.ok) return { error: p.msg };
    const r = await runArgv([soffice, '--headless', '--convert-to', 'pdf', '--outdir', dir, docx], { cwd: dir, timeoutMs: 120_000 });
    const pdf = readdirSync(dir).find((f) => f.endsWith('.pdf'));
    if (r.exitCode !== 0 || !pdf) return { error: (r.stderr || r.stdout).trim() || 'libreoffice PDF conversion failed' };
    return { buf: readFileSync(join(dir, pdf)) };
  }
  const engine = await firstBin(['weasyprint', 'wkhtmltopdf', 'xelatex', 'pdflatex', 'tectonic']);
  if (!engine) return { error: 'install libreoffice (or a pandoc PDF engine: weasyprint/wkhtmltopdf/latex) to generate PDF' };
  const out = join(dir, 'out.pdf');
  const p = await pandoc(['-f', from, inFile, '-o', out, `--pdf-engine=${engine}`], dir);
  if (!p.ok) return { error: p.msg };
  return { buf: readFileSync(out) };
}

export const documentGenerate = defineTool<{ content: string; to: string; from?: string; filename?: string }>({
  name: 'document_generate',
  description:
    'Generate a document file from Markdown or HTML source and attach it to the reply. Output formats: pdf, docx (Word), html, pptx (PowerPoint — splits on headings / "---" slide breaks), md. PDF/DOCX/PPTX use host pandoc (+ libreoffice for PDF).',
  toolset: 'data',
  risk: 'safe',
  parameters: params(
    {
      content: str('Document source text (Markdown by default, or HTML if from="html")'),
      to: strEnum(['pdf', 'docx', 'html', 'pptx', 'md'], 'Output format'),
      from: strEnum(['markdown', 'html'], 'Source format (default markdown)'),
      filename: str('Base filename without extension (default "document")'),
    },
    ['content', 'to'],
  ),
  async execute(a, ctx) {
    const to = a.to;
    const from = a.from ?? 'markdown';
    const base = (a.filename ?? 'document').replace(/[^\w.-]/g, '_') || 'document';
    const dir = scratch();
    try {
      const inFile = join(dir, from === 'html' ? 'input.html' : 'input.md');
      writeFileSync(inFile, a.content);
      let buf: Buffer;
      if (to === 'pdf') {
        const r = await toPdf(dir, inFile, from);
        if (!r.buf) return { content: `Could not generate PDF: ${r.error}`, isError: true };
        buf = r.buf;
      } else {
        const out = join(dir, `out.${to}`);
        const argv =
          to === 'html'
            ? ['-f', from, '-t', 'html5', '--standalone', inFile, '-o', out]
            : to === 'md'
              ? ['-f', from, '-t', 'gfm', inFile, '-o', out]
              : ['-f', from, '-t', to, inFile, '-o', out]; // docx | pptx
        const p = await pandoc(argv, dir);
        if (!p.ok) return { content: `Could not generate ${to.toUpperCase()}: ${p.msg}`, isError: true };
        buf = readFileSync(out);
      }
      const att = await ctx.services.attachments.save(ctx.principal.userId, `${base}.${to}`, buf, OUT_MIME[to]);
      return { content: `Generated ${to.toUpperCase()} document ${att.id} (${buf.length} bytes).`, attachments: [att] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

// ---------------------------------------------------------------------------
// spreadsheet_generate — JSON rows / CSV → .xlsx (hand-written OOXML via host zip)
// ---------------------------------------------------------------------------

/** RFC4180-ish CSV parse (local copy to avoid a cross-file import cycle). */
function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Normalise the tool input into a 2-D grid of cell strings. */
function toGrid(a: { rows?: string; csv?: string; header?: string[] }): string[][] {
  const grid: string[][] = [];
  if (a.csv != null) {
    for (const r of parseCsvRows(a.csv)) if (r.some((c) => c !== '')) grid.push(r);
    if (a.header && a.header.length) grid.unshift(a.header);
    return grid;
  }
  if (a.rows != null) {
    const parsed = JSON.parse(a.rows) as unknown;
    if (!Array.isArray(parsed)) throw new Error('rows must be a JSON array');
    const objectMode = parsed.length > 0 && parsed.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
    if (objectMode) {
      const cols = a.header && a.header.length ? a.header : [...new Set(parsed.flatMap((r) => Object.keys(r as object)))];
      grid.push(cols);
      for (const r of parsed) grid.push(cols.map((c) => stringify((r as Record<string, unknown>)[c])));
    } else {
      if (a.header && a.header.length) grid.push(a.header);
      for (const r of parsed) grid.push((Array.isArray(r) ? r : [r]).map(stringify));
    }
  }
  return grid;
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESC[c]!);
}

/** A1-style column letter for a 0-based column index. */
function colLetter(n: number): string {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
}

/** Build the <sheetData> body. Numeric-looking cells become numbers; everything else inline strings. */
function sheetData(grid: string[][]): string {
  return grid
    .map((row, r) => {
      const cells = row
        .map((val, c) => {
          const ref = `${colLetter(c)}${r + 1}`;
          if (val === '') return '';
          if (/^-?\d+(\.\d+)?$/.test(val) && Number.isFinite(Number(val))) return `<c r="${ref}"><v>${val}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
}

/** Minimal, valid .xlsx OOXML package written under `dir`, zipped via the host `zip` binary. */
async function buildXlsx(dir: string, grid: string[][], sheetName: string): Promise<Buffer> {
  const safeName = xmlEscape(sheetName).slice(0, 31) || 'Sheet1';
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetData(grid)}</sheetData></worksheet>`,
  };
  const root = mkdtempSync(join(dir, 'xlsx-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const out = join(dir, 'book.xlsx');
  // `zip -X` (no extra fields) keeps the archive minimal and deterministic.
  const r = await runArgv(['zip', '-r', '-X', '-q', out, '.'], { cwd: root, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim() || 'zip failed');
  return readFileSync(out);
}

export const spreadsheetGenerate = defineTool<{ rows?: string; csv?: string; header?: string[]; sheet_name?: string; filename?: string }>({
  name: 'spreadsheet_generate',
  description:
    'Generate an Excel .xlsx spreadsheet from structured data and attach it to the reply. Provide either rows (a JSON array of objects or of arrays) or csv (CSV text). Optional header (column names) and sheet_name.',
  toolset: 'data',
  risk: 'safe',
  parameters: params(
    {
      rows: str('JSON array: array of objects (keys → columns) or array of row arrays'),
      csv: str('CSV text (alternative to rows)'),
      header: arr(str('column name'), 'Optional explicit header row'),
      sheet_name: str('Worksheet name (default "Sheet1")'),
      filename: str('Base filename without extension (default "spreadsheet")'),
    },
    [],
  ),
  async execute(a, ctx) {
    if (a.rows == null && a.csv == null) return { content: 'Provide "rows" (JSON array) or "csv" text to build a spreadsheet.', isError: true };
    if (!(await hasBin('zip'))) return { content: 'install zip to generate .xlsx spreadsheets.', isError: true };
    let grid: string[][];
    try {
      grid = toGrid(a);
    } catch (e) {
      return { content: `Invalid spreadsheet input: ${(e as Error).message}`, isError: true };
    }
    if (grid.length === 0) return { content: 'No rows to write.', isError: true };
    const base = (a.filename ?? 'spreadsheet').replace(/[^\w.-]/g, '_') || 'spreadsheet';
    const dir = scratch();
    try {
      const buf = await buildXlsx(dir, grid, a.sheet_name ?? 'Sheet1');
      const att = await ctx.services.attachments.save(ctx.principal.userId, `${base}.xlsx`, buf, OUT_MIME.xlsx);
      return { content: `Generated spreadsheet ${att.id} (${grid.length} row(s), ${buf.length} bytes).`, attachments: [att] };
    } catch (e) {
      return { content: `Could not generate spreadsheet: ${(e as Error).message}`, isError: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

export const documentTools: AnyTool[] = [documentGenerate, spreadsheetGenerate];
