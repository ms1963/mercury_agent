/**
 * Full-home backup / restore engine for Mercury (Tier-1 gap #2).
 *
 * Where {@link ../bundles/bundle.js | bundles} package a *signed subset of config* for sharing between
 * instances, a **backup** is a complete, self-contained snapshot of a single instance's home directory
 * (`~/.mercury` by default): config, the SQLite memory DB (and its `-wal`/`-shm` sidecars), skills,
 * add-ins, permissions, plugins, wiki, bundles — everything needed to reconstitute the instance.
 *
 * ## Archive format (`.mbak`)
 * An `.mbak` file is a **gzipped JSON document** ({@link BackupArchive}) with three parts:
 *   - `manifest` — metadata plus one {@link BackupEntry} per file (relative posix path, mode, byte
 *     length and per-file SHA-256). This is the table of contents.
 *   - `files` — a map of `relativePath -> base64(contents)`. Base64 keeps the document pure JSON so it
 *     survives `JSON.parse` losslessly for binary files (e.g. the SQLite DB).
 *   - `digest` — SHA-256 (hex) of `canonicalJson({ manifest, files })`; the tamper/corruption check.
 *   - `signature` — optional HMAC-SHA256 (hex) over the same canonical payload, keyed by this
 *     instance's audit key. Lets a restore confirm a backup came from *this* instance.
 *
 * ## Determinism
 * Every builder sorts entries and file keys by path, and `canonicalJson` recursively sorts object keys,
 * so two backups of identical inputs (with the same `createdAt`) produce identical digests, signatures
 * and — because Node's `gzipSync` writes a zero mtime — identical serialized bytes. This makes the
 * format trivially testable and diffable.
 *
 * ## Secret-exclusion default
 * {@link collectDataDir} skips the two secret-bearing files (`.env`, `audit.key`) **by default**, so a
 * backup is safe to hand to a colleague or store off-box. Pass `includeSecrets: true` for a true
 * disaster-recovery snapshot (e.g. the pre-restore safety backup), which still excludes volatile junk
 * (`*.log`, `*.mbak`, sockets, pids, temp files, `node_modules/`, `.git/`).
 *
 * The module is split into PURE functions (no fs — fully unit-testable) and a thin layer of fs helpers.
 */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { hmacHex, safeEqual } from '../security/misc.js';
import { canonicalJson, majorOf } from '../bundles/bundle.js';

/** Wire-format version of the `.mbak` document. Bumped only on breaking format changes. */
export const BACKUP_FORMAT_VERSION = 1;

/** One file's entry in the manifest (table of contents). `path` is relative and posix-style. */
export interface BackupEntry {
  path: string;
  mode: number;
  bytes: number;
  sha256: string;
}

/** An in-memory file for the pure layer (no fs). `data` holds the raw bytes. */
export interface FileEntry {
  path: string;
  mode: number;
  data: Buffer;
}

/** Backup metadata plus the per-file table of contents. */
export interface BackupManifest {
  formatVersion: number;
  mercuryVersion: string;
  createdAt: string;
  dataDir: string;
  fileCount: number;
  totalBytes: number;
  includedSecrets: boolean;
  entries: BackupEntry[];
}

/** The complete archive document that is gzipped into an `.mbak` file. */
export interface BackupArchive {
  manifest: BackupManifest;
  /** relativePath -> base64(contents) */
  files: Record<string, string>;
  /** SHA-256 (hex) of canonicalJson({ manifest, files }). */
  digest: string;
  /** Optional HMAC-SHA256 (hex) over the same canonical payload, keyed by the instance audit key. */
  signature?: string;
}

/** Options for {@link buildArchive}. */
export interface BackupOptions {
  mercuryVersion: string;
  dataDir: string;
  createdAt: string;
  includeSecrets: boolean;
  /** When provided, the archive is signed with an HMAC over its canonical payload. */
  secret?: string;
}

/** The effect a restore would have on the destination, computed without writing anything. */
export interface RestorePlan {
  willCreate: string[];
  willOverwrite: string[];
}

// ───────────────────────────────── pure layer (no fs) ─────────────────────────────────

/** SHA-256 (hex) of a buffer. */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The exact canonical payload covered by both the digest and the signature. */
function integrityPayload(manifest: BackupManifest, files: Record<string, string>): string {
  return canonicalJson({ manifest, files });
}

/** Recompute the content digest of an archive from its manifest + files (ignores stored digest). */
export function digestOfArchive(archive: BackupArchive): string {
  return createHash('sha256').update(integrityPayload(archive.manifest, archive.files)).digest('hex');
}

/** Compute the HMAC-SHA256 signature (hex) for a manifest + files under `secret`. */
export function signArchive(manifest: BackupManifest, files: Record<string, string>, secret: string): string {
  return hmacHex(secret, integrityPayload(manifest, files));
}

/** Verify an archive's signature against `secret` (constant-time). False when unsigned. */
export function verifyArchive(archive: BackupArchive, secret: string): boolean {
  if (!archive.signature) return false;
  return safeEqual(archive.signature, signArchive(archive.manifest, archive.files, secret));
}

/**
 * Build a deterministic, integrity-stamped archive from in-memory files. Entries and file keys are
 * sorted by path so identical inputs yield identical bytes. Signs the archive when `secret` is given.
 */
export function buildArchive(files: FileEntry[], opts: BackupOptions): BackupArchive {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: BackupEntry[] = [];
  const fileMap: Record<string, string> = {};
  let totalBytes = 0;
  for (const f of sorted) {
    entries.push({ path: f.path, mode: f.mode, bytes: f.data.length, sha256: sha256Hex(f.data) });
    fileMap[f.path] = f.data.toString('base64');
    totalBytes += f.data.length;
  }
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    mercuryVersion: opts.mercuryVersion,
    createdAt: opts.createdAt,
    dataDir: opts.dataDir,
    fileCount: entries.length,
    totalBytes,
    includedSecrets: opts.includeSecrets,
    entries,
  };
  const digest = createHash('sha256').update(integrityPayload(manifest, fileMap)).digest('hex');
  const archive: BackupArchive = { manifest, files: fileMap, digest };
  if (opts.secret) archive.signature = signArchive(manifest, fileMap, opts.secret);
  return archive;
}

/**
 * Primary tamper/corruption check — needs no secret. Recomputes the content digest and every per-file
 * SHA-256 from the base64 payloads and compares them to what the manifest claims.
 */
export function verifyArchiveIntegrity(archive: BackupArchive): {
  digestValid: boolean;
  fileHashesValid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const digestValid = safeEqual(archive.digest ?? '', digestOfArchive(archive));
  if (!digestValid) issues.push('content digest does not match (archive is corrupt or was tampered with)');

  let fileHashesValid = true;
  const entries = archive.manifest?.entries ?? [];
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(entry.path);
    const b64 = archive.files?.[entry.path];
    if (b64 === undefined) {
      fileHashesValid = false;
      issues.push(`missing file payload for "${entry.path}"`);
      continue;
    }
    const data = Buffer.from(b64, 'base64');
    if (sha256Hex(data) !== entry.sha256) {
      fileHashesValid = false;
      issues.push(`checksum mismatch for "${entry.path}"`);
    } else if (data.length !== entry.bytes) {
      fileHashesValid = false;
      issues.push(`byte-length mismatch for "${entry.path}"`);
    }
  }
  // A payload with no manifest entry is an inconsistency too.
  for (const path of Object.keys(archive.files ?? {})) {
    if (!seen.has(path)) {
      fileHashesValid = false;
      issues.push(`orphan file payload "${path}" has no manifest entry`);
    }
  }
  return { digestValid, fileHashesValid, issues };
}

/**
 * Compatibility check: the wire format must not be newer than this build understands, and (best-effort)
 * the archive should not come from a newer Mercury major than this instance.
 */
export function checkArchiveCompat(
  manifest: BackupManifest,
  currentMercuryVersion: string,
): { compatible: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    issues.push(
      `backup format v${manifest.formatVersion} is newer than supported v${BACKUP_FORMAT_VERSION}; upgrade Mercury to restore it`,
    );
  }
  if (majorOf(manifest.mercuryVersion) > majorOf(currentMercuryVersion)) {
    issues.push(
      `backup was created on Mercury v${manifest.mercuryVersion}, newer than this instance v${currentMercuryVersion}`,
    );
  }
  return { compatible: issues.length === 0, issues };
}

/** Serialize an archive to `.mbak` bytes. Node's gzip writes mtime=0, so this is deterministic. */
export function serializeArchive(archive: BackupArchive): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(archive)), { level: 9 });
}

/** Parse `.mbak` bytes back into an archive, validating the top-level shape. */
export function parseArchive(buf: Buffer): BackupArchive {
  let json: string;
  try {
    json = gunzipSync(buf).toString('utf8');
  } catch {
    throw new Error('not a valid .mbak archive (gzip decompression failed)');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('not a valid .mbak archive (malformed JSON)');
  }
  const a = value as Partial<BackupArchive>;
  if (!a || typeof a !== 'object') throw new Error('not a valid .mbak archive (not an object)');
  if (!a.manifest || typeof a.manifest !== 'object') throw new Error('not a valid .mbak archive (missing manifest)');
  if (!Array.isArray((a.manifest as BackupManifest).entries)) {
    throw new Error('not a valid .mbak archive (manifest has no entries)');
  }
  if (!a.files || typeof a.files !== 'object') throw new Error('not a valid .mbak archive (missing files)');
  if (typeof a.digest !== 'string') throw new Error('not a valid .mbak archive (missing digest)');
  return a as BackupArchive;
}

/** Decode an archive's base64 payloads back into in-memory {@link FileEntry} buffers. */
export function restoreFiles(archive: BackupArchive): FileEntry[] {
  return archive.manifest.entries.map((e) => ({
    path: e.path,
    mode: e.mode,
    data: Buffer.from(archive.files[e.path] ?? '', 'base64'),
  }));
}

// ───────────────────────────────── fs layer (thin) ─────────────────────────────────

/** Secret-bearing files excluded unless `includeSecrets` is set. */
const SECRET_BASENAMES = new Set(['.env', 'audit.key']);
/** Always-excluded path segments (anywhere in the relative path). */
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git']);

/** Whether a relative posix path should be excluded from a backup. */
function isExcluded(relPosix: string, includeSecrets: boolean): boolean {
  const segments = relPosix.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((s) => EXCLUDED_SEGMENTS.has(s))) return true;
  if (/\.(log|mbak|sock|pid|tmp)$/.test(base)) return true;
  if (!includeSecrets && SECRET_BASENAMES.has(base)) return true;
  return false;
}

/**
 * Recursively collect regular files under `dataDir` into {@link FileEntry}s (relative posix paths,
 * permission bits, raw bytes), applying the exclusion rules. Symlinks and non-regular files are
 * skipped. The result is sorted by path for determinism. Includes `mercury.db` and its `-wal`/`-shm`
 * sidecars when present.
 */
export function collectDataDir(dataDir: string, opts: { includeSecrets?: boolean } = {}): FileEntry[] {
  const includeSecrets = !!opts.includeSecrets;
  const out: FileEntry[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      // Compute the relative posix path for exclusion + storage.
      const relPosix = relative(dataDir, abs).split(sep).join(posix.sep);
      if (st.isSymbolicLink()) continue; // never follow or store symlinks
      if (st.isDirectory()) {
        if (isExcluded(relPosix + '/x', includeSecrets)) continue; // skip excluded dirs (node_modules/.git)
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue; // sockets, fifos, devices
      if (isExcluded(relPosix, includeSecrets)) continue;
      let data: Buffer;
      try {
        data = readFileSync(abs);
      } catch {
        continue;
      }
      out.push({ path: relPosix, mode: st.mode & 0o777, data });
    }
  };
  walk(dataDir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Decide, without writing, which archive entries would create vs overwrite files under `destDir`. */
export function planRestore(archive: BackupArchive, destDir: string): RestorePlan {
  const willCreate: string[] = [];
  const willOverwrite: string[] = [];
  for (const entry of archive.manifest.entries) {
    const abs = join(destDir, entry.path);
    let exists = false;
    try {
      exists = statSync(abs).isFile();
    } catch {
      exists = false;
    }
    if (exists) willOverwrite.push(entry.path);
    else willCreate.push(entry.path);
  }
  return { willCreate, willOverwrite };
}

/** Serialize and write an archive to `path`. */
export function writeArchiveFile(path: string, archive: BackupArchive): void {
  writeFileSync(path, serializeArchive(archive));
}

/** Read and parse an `.mbak` file from disk. */
export function readArchiveFile(path: string): BackupArchive {
  if (!existsSync(path)) throw new Error(`backup file not found: ${path}`);
  return parseArchive(readFileSync(path));
}

/**
 * Restore an archive's files into `destDir`. Verifies integrity FIRST (digest + every per-file hash)
 * and throws before writing anything if the archive is corrupt — so a restore is all-or-nothing with
 * respect to tamper detection. Recreates parent directories and restores stored permission bits.
 */
export function restoreArchive(archive: BackupArchive, destDir: string): { restored: string[] } {
  const integrity = verifyArchiveIntegrity(archive);
  if (!integrity.digestValid || !integrity.fileHashesValid) {
    throw new Error(`refusing to restore a corrupt/tampered archive: ${integrity.issues.join('; ')}`);
  }
  const restored: string[] = [];
  for (const file of restoreFiles(archive)) {
    const abs = join(destDir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.data);
    try {
      chmodSync(abs, file.mode & 0o777);
    } catch {
      /* best-effort: some filesystems reject chmod */
    }
    restored.push(file.path);
  }
  return { restored };
}
