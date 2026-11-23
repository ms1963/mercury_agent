/**
 * Data tools (toolset "data"): JSON querying, CSV parsing, YAML⇄JSON, SQLite queries,
 * archives and document text extraction; plus "system" info.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { cpus, freemem, hostname, platform, release, totalmem, uptime } from 'node:os';
import YAML from 'yaml';
import { defineTool, extractText, sniffMime, type AnyTool } from '@mercury/core';
import { runArgv } from '../terminal/backends.js';
import { arr, bool, num, params, resolvePath, snapshot, str, strEnum, truncate } from '../util.js';

/** Resolve "a.b[0].c" style paths in a JSON value. */
export function jsonPath(value: unknown, path: string): unknown {
  if (!path || path === '.' || path === '$') return value;
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    const key = p.startsWith('[') ? Number(p.slice(1, -1)) : p;
    if (key === '*' && Array.isArray(cur)) return cur;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** RFC4180-ish CSV parser (quotes, escaped quotes, newlines in quotes). */
export function parseCsv(text: string, delimiter = ','): string[][] {
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

export const jsonQuery = defineTool<{ json?: string; path?: string; file?: string }>({
  name: 'json_query',
  description: 'Extract a value from JSON (inline or a file) with a path like "items[0].name".',
  toolset: 'data',
  risk: 'safe',
  parameters: params({ json: str('JSON text'), file: str('JSON file path'), path: str('Path, e.g. data.items[2].id') }),
  async execute(a, ctx) {
    const text = a.file ? readFileSync(resolvePath(ctx, a.file), 'utf8') : a.json ?? 'null';
    return truncate(JSON.stringify(jsonPath(JSON.parse(text), a.path ?? ''), null, 2) ?? 'undefined');
  },
});

export const csvParse = defineTool<{ csv?: string; file?: string; delimiter?: string; limit?: number }>({
  name: 'csv_parse',
  description: 'Parse CSV (inline or file) into JSON objects using the header row. Also reports column names and row count.',
  toolset: 'data',
  risk: 'safe',
  parameters: params({ csv: str('CSV text'), file: str('CSV file path'), delimiter: str('Delimiter (default ,)'), limit: num('Max rows returned (default 50)') }),
  async execute(a, ctx) {
    const text = a.file ? readFileSync(resolvePath(ctx, a.file), 'utf8') : a.csv ?? '';
    const [header = [], ...rows] = parseCsv(text, a.delimiter ?? ',');
    const objects = rows.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    return { content: truncate(JSON.stringify({ columns: header, rows: objects.length, data: objects.slice(0, a.limit ?? 50) }, null, 1)), data: objects };
  },
});

export const yamlConvert = defineTool<{ text: string; to: 'json' | 'yaml' }>({
  name: 'yaml_convert',
  description: 'Convert YAML to JSON or JSON to YAML.',
  toolset: 'data',
  risk: 'safe',
  parameters: params({ text: str('Input text'), to: strEnum(['json', 'yaml'], 'Target format') }, ['text', 'to']),
  async execute(a) {
    return a.to === 'json' ? JSON.stringify(YAML.parse(a.text), null, 2) : YAML.stringify(JSON.parse(a.text));
  },
});

export const sqliteQuery = defineTool<{ file: string; sql: string; write?: boolean }>({
  name: 'sqlite_query',
  description: 'Run SQL against a SQLite database file in the workspace. Read-only unless write=true.',
  toolset: 'data',
  risk: 'moderate',
  needsApproval: (a) => (a.write ? `write SQL on ${a.file}` : undefined),
  parameters: params({ file: str('Database file'), sql: str('SQL statement'), write: bool('Allow modifications') }, ['file', 'sql']),
  async execute(a, ctx) {
    const path = resolvePath(ctx, a.file);
    if (a.write) snapshot(ctx, path, `sqlite_query ${a.file}`);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (f: string, o?: object) => { prepare(s: string): { all(): unknown[]; run(): { changes: number } }; close(): void } };
    const db = new DatabaseSync(path, { readOnly: !a.write });
    try {
      const stmt = db.prepare(a.sql);
      if (/^\s*(select|pragma|with|explain)/i.test(a.sql)) return truncate(JSON.stringify(stmt.all().slice(0, 200), null, 1));
      if (!a.write) throw new Error('statement modifies data; set write=true');
      return `changes: ${stmt.run().changes}`;
    } finally {
      db.close();
    }
  },
});

export const archiveTool = defineTool<{ action: 'create' | 'extract' | 'list'; archive: string; files?: string[]; dest?: string }>({
  name: 'archive',
  description: 'Create, extract or list .tar.gz / .zip archives (uses tar/unzip/zip on the host).',
  toolset: 'data',
  risk: 'moderate',
  parameters: params({ action: strEnum(['create', 'extract', 'list'], 'Action'), archive: str('Archive path'), files: arr(str('path'), 'Files to add (create)'), dest: str('Destination folder (extract)') }, ['action', 'archive']),
  async execute(a, ctx) {
    const archive = resolvePath(ctx, a.archive);
    const zip = archive.endsWith('.zip');
    let argv: string[];
    if (a.action === 'list') argv = zip ? ['unzip', '-l', archive] : ['tar', '-tzf', archive];
    else if (a.action === 'extract') {
      const dest = resolvePath(ctx, a.dest ?? '.');
      argv = zip ? ['unzip', '-o', archive, '-d', dest] : ['tar', '-xzf', archive, '-C', dest, '--no-same-owner'];
    } else {
      const files = (a.files ?? ['.']).map((f) => resolvePath(ctx, f));
      argv = zip ? ['zip', '-r', archive, ...files] : ['tar', '-czf', archive, ...files];
    }
    const r = await runArgv(argv, { cwd: ctx.workdir, timeoutMs: 120_000 });
    return { content: truncate(r.stdout + r.stderr) || 'done', isError: r.exitCode !== 0 };
  },
});

export const documentText = defineTool<{ path: string }>({
  name: 'document_text',
  description: 'Extract text from a document (PDF via pdftotext, Word .docx, Excel .xlsx, PowerPoint .pptx, HTML, plain text).',
  toolset: 'data',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ path: str('File path') }, ['path']),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    return truncate(await extractText(p, sniffMime(readFileSync(p).subarray(0, 64), p)));
  },
});

export const systemInfo = defineTool<Record<string, never>>({
  name: 'system_info',
  description: 'Host information: OS, CPU, memory, uptime, Node version.',
  toolset: 'system',
  risk: 'safe',
  parameters: params({}),
  async execute() {
    return JSON.stringify({ hostname: hostname(), os: `${platform()} ${release()}`, cpus: cpus().length, memoryGb: +(totalmem() / 1e9).toFixed(1), freeGb: +(freemem() / 1e9).toFixed(1), uptimeH: +(uptime() / 3600).toFixed(1), node: process.version }, null, 1);
  },
});

export const dataTools: AnyTool[] = [jsonQuery, csvParse, yamlConvert, sqliteQuery, archiveTool, documentText, systemInfo];
