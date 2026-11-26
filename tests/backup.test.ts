/**
 * Tests for the full-home backup / restore engine (`mercury backup` / `mercury import`).
 *
 * SCOPE: fully offline and deterministic. The pure layer is exercised purely in-memory; the fs layer
 * uses real temp directories created with mkdtempSync and cleaned up in afterEach. No network.
 *
 * Covers: pure archive round-trip (serialize→parse→restoreFiles byte-identical), determinism (equal
 * digest + equal serialized bytes for identical inputs), integrity (fresh archive passes, tampering
 * fails), HMAC signature (right/wrong secret, absent), compatibility gating, collectDataDir exclusion
 * rules (secrets/logs/mbak/node_modules/.git) with and without includeSecrets, fs restore round-trip
 * with mode preservation, planRestore overwrite detection, and malformed-input parsing errors.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  BACKUP_FORMAT_VERSION,
  buildArchive,
  checkArchiveCompat,
  collectDataDir,
  digestOfArchive,
  parseArchive,
  planRestore,
  restoreArchive,
  restoreFiles,
  serializeArchive,
  signArchive,
  verifyArchive,
  verifyArchiveIntegrity,
  type FileEntry,
} from '@mercury/core';

const SECRET = 'test-audit-key-0123456789';
const BASE_OPTS = { mercuryVersion: '1.8.1', dataDir: '/home/u/.mercury', createdAt: '2026-01-01T00:00:00.000Z' };

function sampleFiles(): FileEntry[] {
  return [
    { path: 'config.yaml', mode: 0o644, data: Buffer.from('model: test\n') },
    { path: 'skills/a.md', mode: 0o644, data: Buffer.from('# skill a') },
    { path: 'mercury.db', mode: 0o600, data: Buffer.from([0, 1, 2, 255, 254, 0, 42]) }, // binary
  ];
}

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('backup — pure archive layer', () => {
  it('round-trips buildArchive → serialize → parse to a deep-equal archive', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    const reparsed = parseArchive(serializeArchive(archive));
    expect(reparsed).toEqual(archive);
  });

  it('restoreFiles returns byte-identical buffers (including binary)', () => {
    const files = sampleFiles();
    const archive = buildArchive(files, { ...BASE_OPTS, includeSecrets: false });
    const restored = restoreFiles(archive).sort((a, b) => a.path.localeCompare(b.path));
    const original = [...files].sort((a, b) => a.path.localeCompare(b.path));
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]!.path).toBe(original[i]!.path);
      expect(restored[i]!.mode).toBe(original[i]!.mode);
      expect(Buffer.compare(restored[i]!.data, original[i]!.data)).toBe(0);
    }
  });

  it('is deterministic: identical inputs yield identical digest AND serialized bytes', () => {
    const a1 = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    const a2 = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    expect(a1.digest).toBe(a2.digest);
    expect(a1.signature).toBe(a2.signature);
    expect(a1).toEqual(a2);
    expect(Buffer.compare(serializeArchive(a1), serializeArchive(a2))).toBe(0);
  });

  it('builds a correct manifest (sorted entries, counts, totals, format version)', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    const m = archive.manifest;
    expect(m.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(m.fileCount).toBe(3);
    expect(m.totalBytes).toBe(sampleFiles().reduce((n, f) => n + f.data.length, 0));
    expect(m.entries.map((e) => e.path)).toEqual(['config.yaml', 'mercury.db', 'skills/a.md']);
    expect(m.includedSecrets).toBe(false);
  });
});

describe('backup — integrity verification', () => {
  it('passes on a fresh archive', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    const res = verifyArchiveIntegrity(archive);
    expect(res.digestValid).toBe(true);
    expect(res.fileHashesValid).toBe(true);
    expect(res.issues).toEqual([]);
    expect(digestOfArchive(archive)).toBe(archive.digest);
  });

  it('detects a tampered file payload', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    archive.files['config.yaml'] = Buffer.from('EVIL').toString('base64');
    const res = verifyArchiveIntegrity(archive);
    expect(res.digestValid).toBe(false);
    expect(res.fileHashesValid).toBe(false);
    expect(res.issues.join(' ')).toMatch(/config\.yaml/);
  });

  it('detects a tampered manifest', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    archive.manifest.fileCount = 99;
    expect(verifyArchiveIntegrity(archive).digestValid).toBe(false);
  });

  it('detects an orphan payload with no manifest entry', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    archive.files['ghost.txt'] = Buffer.from('x').toString('base64');
    const res = verifyArchiveIntegrity(archive);
    expect(res.fileHashesValid).toBe(false);
    expect(res.issues.join(' ')).toMatch(/orphan/);
  });
});

describe('backup — signature', () => {
  it('verifyArchive is true with the right secret, false with a wrong one', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    expect(verifyArchive(archive, SECRET)).toBe(true);
    expect(verifyArchive(archive, 'wrong-secret')).toBe(false);
  });

  it('verifyArchive is false when the archive is unsigned', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    expect(archive.signature).toBeUndefined();
    expect(verifyArchive(archive, SECRET)).toBe(false);
  });

  it('signArchive matches the signature embedded by buildArchive', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    expect(archive.signature).toBe(signArchive(archive.manifest, archive.files, SECRET));
  });
});

describe('backup — compatibility', () => {
  it('flags a newer wire format as incompatible', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    archive.manifest.formatVersion = BACKUP_FORMAT_VERSION + 1;
    const res = checkArchiveCompat(archive.manifest, '1.8.1');
    expect(res.compatible).toBe(false);
    expect(res.issues.join(' ')).toMatch(/format/);
  });

  it('flags a newer Mercury major as incompatible', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, mercuryVersion: '2.0.0', includeSecrets: false });
    expect(checkArchiveCompat(archive.manifest, '1.8.1').compatible).toBe(false);
  });

  it('accepts an equal or older version', () => {
    const older = buildArchive(sampleFiles(), { ...BASE_OPTS, mercuryVersion: '1.7.0', includeSecrets: false });
    expect(checkArchiveCompat(older.manifest, '1.8.1').compatible).toBe(true);
    const equal = buildArchive(sampleFiles(), { ...BASE_OPTS, mercuryVersion: '1.8.1', includeSecrets: false });
    expect(checkArchiveCompat(equal.manifest, '1.8.1').compatible).toBe(true);
  });
});

describe('backup — parseArchive error handling', () => {
  it('throws a clear error on non-gzip input', () => {
    expect(() => parseArchive(Buffer.from('not gzip at all'))).toThrow(/\.mbak/);
  });

  it('throws a clear error on gzipped non-JSON', () => {
    // gunzip succeeds but the payload is malformed JSON.
    expect(() => parseArchive(gzipSync(Buffer.from('{not json')))).toThrow(/\.mbak/);
  });

  it('throws when required fields are missing', () => {
    const noManifest = gzipSync(Buffer.from(JSON.stringify({ files: {}, digest: 'x' })));
    expect(() => parseArchive(noManifest)).toThrow(/manifest/);
  });
});

describe('backup — collectDataDir exclusions (fs)', () => {
  function buildHome(): string {
    const dir = tmp('mercury-bak-src-');
    mkdirSync(join(dir, 'skills'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), 'model: test');
    writeFileSync(join(dir, 'skills', 'a.md'), '# a');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'audit.key'), 'k');
    writeFileSync(join(dir, 'x.log'), 'log');
    writeFileSync(join(dir, 'old.mbak'), 'archive');
    writeFileSync(join(dir, 'mercury.db'), 'db');
    writeFileSync(join(dir, 'mercury.db-wal'), 'wal');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    return dir;
  }

  it('excludes secrets/logs/mbak/node_modules/.git by default; includes real data + db sidecars', () => {
    const dir = buildHome();
    const paths = collectDataDir(dir).map((f) => f.path);
    expect(paths).toContain('config.yaml');
    expect(paths).toContain('skills/a.md');
    expect(paths).toContain('mercury.db');
    expect(paths).toContain('mercury.db-wal');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('audit.key');
    expect(paths).not.toContain('x.log');
    expect(paths).not.toContain('old.mbak');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    // Deterministic sort.
    expect(paths).toEqual([...paths].sort());
  });

  it('includes .env and audit.key with includeSecrets=true (but still excludes .log/.mbak)', () => {
    const dir = buildHome();
    const paths = collectDataDir(dir, { includeSecrets: true }).map((f) => f.path);
    expect(paths).toContain('.env');
    expect(paths).toContain('audit.key');
    expect(paths).not.toContain('x.log');
    expect(paths).not.toContain('old.mbak');
  });

  it('skips symlinks', () => {
    const dir = tmp('mercury-bak-link-');
    writeFileSync(join(dir, 'real.txt'), 'hi');
    try {
      symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    } catch {
      return; // symlink not permitted on this fs; skip assertion
    }
    const paths = collectDataDir(dir).map((f) => f.path);
    expect(paths).toContain('real.txt');
    expect(paths).not.toContain('link.txt');
  });
});

describe('backup — fs restore round-trip', () => {
  it('restores every file with identical bytes and preserved mode', () => {
    const src = tmp('mercury-bak-src-');
    mkdirSync(join(src, 'skills'), { recursive: true });
    writeFileSync(join(src, 'config.yaml'), 'model: test');
    writeFileSync(join(src, 'skills', 'a.md'), '# skill');
    const exe = join(src, 'run.sh');
    writeFileSync(exe, '#!/bin/sh\necho hi');
    chmodSync(exe, 0o755);

    const archive = buildArchive(collectDataDir(src), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    const dest = tmp('mercury-bak-dest-');
    const { restored } = restoreArchive(archive, dest);

    expect(restored.sort()).toEqual(['config.yaml', 'run.sh', 'skills/a.md']);
    expect(readFileSync(join(dest, 'config.yaml'), 'utf8')).toBe('model: test');
    expect(readFileSync(join(dest, 'skills', 'a.md'), 'utf8')).toBe('# skill');
    expect(statSync(join(dest, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('restoreArchive refuses to write a tampered archive', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false, secret: SECRET });
    archive.files['config.yaml'] = Buffer.from('EVIL').toString('base64');
    const dest = tmp('mercury-bak-dest-');
    expect(() => restoreArchive(archive, dest)).toThrow(/corrupt|tamper/i);
  });

  it('planRestore reports existing files as willOverwrite', () => {
    const archive = buildArchive(sampleFiles(), { ...BASE_OPTS, includeSecrets: false });
    const dest = tmp('mercury-bak-dest-');
    writeFileSync(join(dest, 'config.yaml'), 'pre-existing');
    const plan = planRestore(archive, dest);
    expect(plan.willOverwrite).toContain('config.yaml');
    expect(plan.willCreate).toContain('mercury.db');
    expect(plan.willCreate).toContain('skills/a.md');
  });
});
