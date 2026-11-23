/** Office OOXML attachment handling: classification, MIME sniffing, and text extraction. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText, kindOf, sniffMime } from '@mercury/core';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function have(bin: string): boolean {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
const toolsPresent = have('zip') && have('unzip');

/** Build an OOXML container (a zip of the given {entry: xml} map) at `file`. */
function buildOoxml(dir: string, file: string, entries: Record<string, string>): string {
  const root = mkdtempSync(join(dir, 'ooxml-'));
  for (const [name, content] of Object.entries(entries)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  const out = join(dir, file);
  execFileSync('zip', ['-r', '-q', out, '.'], { cwd: root });
  return out;
}

describe('Office OOXML attachments', () => {
  it('sniffs Office extensions to their OOXML MIME types', () => {
    const pk = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffMime(pk, 'report.docx')).toBe(DOCX);
    expect(sniffMime(pk, 'budget.xlsx')).toBe(XLSX);
    expect(sniffMime(pk, 'deck.pptx')).toBe(PPTX);
  });

  it('classifies Office OOXML as a document kind (so it is enriched, not dropped)', () => {
    expect(kindOf(DOCX)).toBe('document');
    expect(kindOf(XLSX)).toBe('document');
    expect(kindOf(PPTX)).toBe('document');
  });

  it('degrades gracefully instead of raw-reading a binary OOXML container', async () => {
    // Nonexistent file → unzip fails → friendly message, never a UTF-8 garbage dump or throw.
    const msg = await extractText(join(tmpdir(), 'does-not-exist.docx'), DOCX);
    expect(msg).toMatch(/Word document received/);
  });

  describe.skipIf(!toolsPresent)('text extraction (requires zip/unzip)', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ooxml-test-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('extracts Word text with paragraph breaks and decoded entities', async () => {
      const f = buildOoxml(dir, 'doc.docx', {
        'word/document.xml':
          '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
          '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> World</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p></w:body></w:document>',
      });
      const text = await extractText(f, DOCX);
      expect(text).toContain('Hello World');
      expect(text).toContain('Second & line');
      // Paragraphs are separated, not run together.
      expect(text).toMatch(/Hello World\nSecond & line/);
    });

    it('extracts PowerPoint text per slide in numeric order', async () => {
      const f = buildOoxml(dir, 'deck.pptx', {
        'ppt/slides/slide2.xml': '<p:sld xmlns:a="x"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
        'ppt/slides/slide1.xml': '<p:sld xmlns:a="x"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
      });
      const text = await extractText(f, PPTX);
      expect(text.indexOf('First slide')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('First slide')).toBeLessThan(text.indexOf('Second slide'));
    });

    it('extracts Excel shared strings and inline strings, not numeric cell indices', async () => {
      const f = buildOoxml(dir, 'book.xlsx', {
        'xl/sharedStrings.xml': '<sst><si><t>Revenue</t></si><si><t>Region</t></si></sst>',
        'xl/worksheets/sheet1.xml':
          '<worksheet><sheetData>' +
          '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
          '<row><c t="inlineStr"><is><t>Inline note</t></is></c></row>' +
          '</sheetData></worksheet>',
      });
      const text = await extractText(f, XLSX);
      expect(text).toContain('Revenue');
      expect(text).toContain('Region');
      expect(text).toContain('Inline note');
      // The shared-string index "0"/"1" in the worksheet must NOT leak in as text.
      expect(text).not.toMatch(/^\s*0\s*$/m);
    });
  });
});
