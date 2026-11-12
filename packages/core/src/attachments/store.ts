/**
 * Attachment store: persists uploaded/received files, sniffs MIME types, enforces size
 * and kind limits, runs an optional scan hook/command, and pre-processes media:
 *   images → inline base64 for vision models
 *   audio  → transcript via STT
 *   video  → key frames + audio track via ffmpeg (if installed) → frames + transcript
 *   text/PDF documents → extracted text (pdftotext if installed)
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { HookManager } from '../plugins/hooks.js';
import { MercuryError, newId, nowIso } from '../types/common.js';
import type { Attachment, AttachmentKind } from '../types/messages.js';
import type { VoiceService } from '../voice/voice.js';

const run = promisify(execFile);

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.webm': 'video/webm',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.yaml': 'text/yaml', '.yml': 'text/yaml',
};

/** Detect MIME from magic bytes, falling back to the file extension. */
export function sniffMime(buf: Buffer, name: string): string {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('4f676753')) return 'audio/ogg';
  if (hex.startsWith('494433') || hex.startsWith('fffb')) return 'audio/mpeg';
  if (hex.startsWith('1a45dfa3')) return name.match(/\.(weba|oga)$/) ? 'audio/webm' : 'video/webm';
  if (buf.subarray(4, 8).toString() === 'ftyp') return /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/mp4';
  return EXT_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function kindOf(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json') return 'document';
  return 'other';
}

let ffmpegAvailable: boolean | undefined;
export async function hasBinary(bin: string): Promise<boolean> {
  try {
    await run(bin, ['-version'], { timeout: 5000 });
    return true;
  } catch (err) {
    // Some binaries (pdftotext) print version to stderr and exit non-zero.
    return (err as { code?: unknown }).code !== 'ENOENT';
  }
}

export class AttachmentStore {
  private dir: string;

  constructor(
    private config: MercuryConfig,
    private db: Db,
    private voice?: VoiceService,
    private hooks?: HookManager,
  ) {
    this.dir = join(config.dataDir, 'attachments');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Validate and persist a file; returns the attachment record (not yet processed). */
  async save(userId: string, name: string, data: Buffer, mimeHint?: string): Promise<Attachment> {
    const max = this.config.attachments.maxBytes;
    if (data.length > max) throw new MercuryError(`Attachment too large (${data.length} > ${max} bytes)`, 'attachment_too_large', 'attachments', 413);
    const mime = mimeHint && mimeHint !== 'application/octet-stream' ? mimeHint : sniffMime(data, name);
    const kind = kindOf(mime);
    if (!this.config.attachments.allowedKinds.includes(kind)) throw new MercuryError(`Attachment kind "${kind}" is not allowed`, 'attachment_kind', 'attachments', 415);
    const id = newId('att');
    const safeName = name.replace(/[^\w.-]/g, '_').slice(-120) || 'file';
    const path = join(this.dir, `${id}_${safeName}`);
    writeFileSync(path, data);
    const att: Attachment = { id, name: safeName, mime, size: data.length, kind, path, trust: 'untrusted' };
    await this.scan(att);
    this.db.run(
      'INSERT INTO attachments (id, user_id, name, mime, size, kind, path, sha256, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, userId, safeName, mime, data.length, kind, path, createHash('sha256').update(data).digest('hex'), toJson({}), nowIso(),
    );
    return att;
  }

  get(id: string): Attachment | undefined {
    const r = this.db.get<{ id: string; name: string; mime: string; size: number; kind: AttachmentKind; path: string; meta: string }>('SELECT * FROM attachments WHERE id = ?', id);
    if (!r) return undefined;
    return { id: r.id, name: r.name, mime: r.mime, size: r.size, kind: r.kind, path: r.path, trust: 'untrusted', ...fromJson<Partial<Attachment>>(r.meta, {}) };
  }

  owner(id: string): string | undefined {
    return this.db.get<{ user_id: string }>('SELECT user_id FROM attachments WHERE id = ?', id)?.user_id;
  }

  /** Malware/content scan: hook first (plugins), then optional external command (exit≠0 → reject). */
  private async scan(att: Attachment): Promise<void> {
    const hook = await this.hooks?.run('attachment_scan', { attachment: att });
    if (hook?.block) throw new MercuryError(`Attachment rejected: ${String(hook.block)}`, 'attachment_rejected', 'attachments', 422);
    const cmd = this.config.attachments.scanCommand;
    if (!cmd) return;
    const [bin, ...args] = cmd.split(/\s+/);
    try {
      await run(bin!, [...args, att.path!], { timeout: 60_000 });
    } catch {
      throw new MercuryError('Attachment rejected by scanner', 'attachment_rejected', 'attachments', 422);
    }
  }

  /** Enrich an attachment for the LLM (inline image data, transcripts, frames, text). */
  async process(att: Attachment): Promise<Attachment> {
    const out = { ...att };
    try {
      if (att.kind === 'image' && att.path && att.size <= 8 * 1024 * 1024) {
        out.data = readFileSync(att.path).toString('base64');
      } else if (att.kind === 'audio' && att.path && this.voice) {
        out.transcript = await this.voice.transcribe(att.path, att.mime);
      } else if (att.kind === 'video' && att.path) {
        Object.assign(out, await this.processVideo(att));
      } else if (att.kind === 'document' && att.path) {
        out.description = await extractText(att.path, att.mime);
      }
    } catch (err) {
      out.description = `${out.description ?? ''} (processing failed: ${String(err)})`.trim();
    }
    this.db.run('UPDATE attachments SET meta = ? WHERE id = ?', toJson({ transcript: out.transcript, description: out.description, frames: out.frames }), att.id);
    return out;
  }

  /** Extract up to 4 frames and the audio track with ffmpeg (when available). */
  private async processVideo(att: Attachment): Promise<Partial<Attachment>> {
    ffmpegAvailable ??= await hasBinary('ffmpeg');
    if (!ffmpegAvailable) return { description: 'Video received (install ffmpeg to extract frames/audio).' };
    const framesDir = `${att.path}_frames`;
    mkdirSync(framesDir, { recursive: true });
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', att.path!, '-vf', 'fps=1/5,scale=512:-1', '-frames:v', '4', join(framesDir, 'frame_%02d.jpg')], { timeout: 120_000 });
    const frames = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).map((f) => join(framesDir, f));
    let transcript: string | undefined;
    if (this.voice) {
      const audio = `${att.path}.wav`;
      try {
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', att.path!, '-vn', '-ac', '1', '-ar', '16000', audio], { timeout: 120_000 });
        if (existsSync(audio)) transcript = await this.voice.transcribe(audio, 'audio/wav');
      } catch {
        /* video without audio track */
      }
    }
    return { frames, transcript, description: `Video with ${frames.length} extracted frame(s).` };
  }
}

/** Plain-text extraction for documents. PDFs use `pdftotext` when installed. */
export async function extractText(path: string, mime: string): Promise<string> {
  if (mime === 'application/pdf') {
    try {
      const { stdout } = await run('pdftotext', ['-layout', path, '-'], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      return stdout.slice(0, 100_000);
    } catch {
      return 'PDF received (install poppler-utils/pdftotext for text extraction).';
    }
  }
  return readFileSync(path, 'utf8').slice(0, 100_000);
}
