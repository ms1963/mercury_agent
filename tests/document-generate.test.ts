/**
 * Document-generation tools: registration, parameter schemas, graceful degradation, and
 * (guarded by host binaries) real file generation. Mirrors the style of attachments-ooxml.test.ts:
 * always-run assertions, plus describe.skipIf(!binaryPresent) blocks for real generation that
 * assert a valid file is produced (docx/xlsx/pptx are valid zip containers with the expected OOXML
 * entries; pdf starts with %PDF).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@mercury/tools';
import type { AnyTool, ToolContext, ToolResult } from '@mercury/core';

/** Normalise a tool result (which may be a bare string) to the object shape. */
function asResult(r: string | ToolResult): ToolResult {
  return typeof r === 'string' ? { content: r } : r;
}

function have(bin: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasPandoc = have('pandoc');
const hasZip = have('zip') && have('unzip');
const hasPdf = hasPandoc && (have('libreoffice') || have('soffice') || have('weasyprint') || have('wkhtmltopdf'));

const docGen = BUILTIN_TOOLS.find((t) => t.name === 'document_generate') as AnyTool;
const sheetGen = BUILTIN_TOOLS.find((t) => t.name === 'spreadsheet_generate') as AnyTool;

/** A ToolContext whose attachments.save records the bytes it is handed. */
function fakeCtx(sink: Array<{ name: string; buf: Buffer; mime: string }>): ToolContext {
  return {
    principal: { userId: 'u1', role: 'user' },
    platform: 'test',
    workdir: tmpdir(),
    depth: 0,
    services: {
      attachments: {
        async save(_userId: string, name: string, buf: Buffer, mime: string) {
          sink.push({ name, buf, mime });
          return { id: `att_${name}`, name, mime, kind: 'document' };
        },
      },
    },
    emit() {},
    async requestApproval() {
      return true;
    },
  } as unknown as ToolContext;
}

/** Entry names inside a zip/OOXML container. */
function zipEntries(file: string): string[] {
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('document-generation tools', () => {
  it('registers document_generate and spreadsheet_generate under the data toolset', () => {
    expect(docGen).toBeTruthy();
    expect(sheetGen).toBeTruthy();
    expect(docGen.toolset).toBe('data');
    expect(sheetGen.toolset).toBe('data');
    expect(docGen.risk).toBe('safe');
    expect(sheetGen.risk).toBe('safe');
  });

  it('exposes a parameter schema with the expected fields and output formats', () => {
    const dp = docGen.parameters as { type: string; properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(dp.type).toBe('object');
    expect(Object.keys(dp.properties)).toEqual(expect.arrayContaining(['content', 'to', 'from', 'filename']));
    expect(dp.required).toEqual(expect.arrayContaining(['content', 'to']));
    expect(dp.properties.to.enum).toEqual(expect.arrayContaining(['pdf', 'docx', 'html', 'pptx', 'md']));

    const sp = sheetGen.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(sp.properties)).toEqual(expect.arrayContaining(['rows', 'csv', 'header', 'sheet_name', 'filename']));
  });

  it('spreadsheet_generate reports an error when given no data', async () => {
    const r = asResult(await sheetGen.execute({}, fakeCtx([])));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/rows.*csv|csv.*rows/i);
  });

  it('spreadsheet_generate reports invalid JSON rows', async () => {
    const r = asResult(await sheetGen.execute({ rows: '{ not an array }' }, fakeCtx([])));
    expect(r.isError).toBe(true);
  });

  (hasPandoc ? it.skip : it)('document_generate degrades gracefully when pandoc is missing', async () => {
    const r = asResult(await docGen.execute({ content: '# Hi', to: 'docx' }, fakeCtx([])));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/install pandoc/i);
  });

  (hasZip ? it.skip : it)('spreadsheet_generate degrades gracefully when zip is missing', async () => {
    const r = asResult(await sheetGen.execute({ rows: '[{"a":1}]' }, fakeCtx([])));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/install zip/i);
  });

  describe.skipIf(!hasPandoc)('real document generation (requires pandoc)', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'docgen-test-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('generates a valid .docx (zip with word/document.xml)', async () => {
      const sink: Array<{ name: string; buf: Buffer; mime: string }> = [];
      const r = asResult(await docGen.execute({ content: '# Title\n\nHello **world**.', to: 'docx' }, fakeCtx(sink)));
      expect(r.isError).toBeFalsy();
      expect(sink).toHaveLength(1);
      expect(sink[0]!.mime).toMatch(/wordprocessingml\.document/);
      const f = join(dir, 'out.docx');
      writeFileSync(f, sink[0]!.buf);
      expect(sink[0]!.buf.subarray(0, 2).toString()).toBe('PK');
      expect(zipEntries(f)).toContain('word/document.xml');
    });

    it('generates a valid .pptx (zip with ppt/presentation.xml) from markdown slides', async () => {
      const sink: Array<{ name: string; buf: Buffer; mime: string }> = [];
      const r = asResult(await docGen.execute({ content: '# Slide 1\n\nbody\n\n# Slide 2\n\nmore', to: 'pptx' }, fakeCtx(sink)));
      expect(r.isError).toBeFalsy();
      expect(sink[0]!.mime).toMatch(/presentationml\.presentation/);
      const f = join(dir, 'out.pptx');
      writeFileSync(f, sink[0]!.buf);
      const entries = zipEntries(f);
      expect(entries).toContain('ppt/presentation.xml');
      expect(entries.some((e) => /ppt\/slides\/slide\d+\.xml/.test(e))).toBe(true);
    });

    it('generates standalone HTML and GFM markdown', async () => {
      const html: Array<{ name: string; buf: Buffer; mime: string }> = [];
      await docGen.execute({ content: '# Hi\n\ntext', to: 'html' }, fakeCtx(html));
      expect(html[0]!.buf.toString()).toMatch(/<html/i);

      const md: Array<{ name: string; buf: Buffer; mime: string }> = [];
      await docGen.execute({ content: '# Hi\n\ntext', to: 'md' }, fakeCtx(md));
      expect(md[0]!.buf.toString()).toMatch(/# Hi/);
    });
  });

  describe.skipIf(!hasPdf)('real PDF generation (requires pandoc + libreoffice/engine)', () => {
    it('generates a file starting with the %PDF magic bytes', async () => {
      const sink: Array<{ name: string; buf: Buffer; mime: string }> = [];
      const r = asResult(await docGen.execute({ content: '# PDF\n\nSome text here.', to: 'pdf' }, fakeCtx(sink)));
      expect(r.isError).toBeFalsy();
      expect(sink[0]!.mime).toBe('application/pdf');
      expect(sink[0]!.buf.subarray(0, 4).toString()).toBe('%PDF');
    });
  });

  describe.skipIf(!hasZip)('real spreadsheet generation (requires zip)', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'xlsxgen-test-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('generates a valid .xlsx (zip with the OOXML workbook/worksheet entries) from objects', async () => {
      const sink: Array<{ name: string; buf: Buffer; mime: string }> = [];
      const r = asResult(await sheetGen.execute({ rows: JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]) }, fakeCtx(sink)));
      expect(r.isError).toBeFalsy();
      expect(sink[0]!.mime).toMatch(/spreadsheetml\.sheet/);
      const f = join(dir, 'out.xlsx');
      writeFileSync(f, sink[0]!.buf);
      expect(sink[0]!.buf.subarray(0, 2).toString()).toBe('PK');
      const entries = zipEntries(f);
      expect(entries).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']));
      // Header cell text is present as an inline string (not a numeric index).
      const sheet = execFileSync('unzip', ['-p', f, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
      expect(sheet).toContain('Alice');
      expect(sheet).toContain('<v>30</v>');
    });

    it('generates a valid .xlsx from CSV text', async () => {
      const sink: Array<{ name: string; buf: Buffer; mime: string }> = [];
      const r = asResult(await sheetGen.execute({ csv: 'a,b\n1,2\n3,4' }, fakeCtx(sink)));
      expect(r.isError).toBeFalsy();
      const f = join(dir, 'csv.xlsx');
      writeFileSync(f, sink[0]!.buf);
      expect(zipEntries(f)).toContain('xl/worksheets/sheet1.xml');
    });
  });
});
