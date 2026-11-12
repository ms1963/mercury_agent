/**
 * Attachment handling for providers: build multimodal parts when the model supports
 * them and degrade gracefully (transcripts, descriptions, frame notes) when it doesn't.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Attachment, ChatMessage, ModelCapabilities } from '../types/messages.js';

export interface ImagePart {
  mime: string;
  base64: string;
}

/** Load image bytes for a vision-capable model. Returns undefined if unavailable/too big. */
export function imageData(a: Attachment, maxBytes = 8 * 1024 * 1024): ImagePart | undefined {
  if (a.kind !== 'image') return undefined;
  if (a.data) return { mime: a.mime, base64: a.data };
  if (a.path && existsSync(a.path) && a.size <= maxBytes) return { mime: a.mime, base64: readFileSync(a.path).toString('base64') };
  return undefined;
}

/** Textual stand-in for an attachment the model cannot consume natively. */
export function attachmentAsText(a: Attachment, caps: ModelCapabilities): string {
  const head = `[Attachment: ${a.name} (${a.mime}, ${Math.round(a.size / 1024)} KB)]`;
  const parts = [head];
  if (a.transcript) parts.push(`Transcript: ${a.transcript}`);
  if (a.description) parts.push(`Content: ${a.description}`);
  if (a.kind === 'video' && a.frames?.length) parts.push(`${a.frames.length} frames extracted${caps.vision ? ' (sent as images)' : ''}.`);
  if (a.kind === 'image' && !caps.vision && !a.description) parts.push('(image not visible to this model — no vision capability)');
  return parts.join('\n');
}

/** Combine message text with attachment stand-ins for text-only rendering. */
export function textWithAttachments(m: ChatMessage, caps: ModelCapabilities, skipImages: boolean): string {
  const extra = (m.attachments ?? [])
    .filter((a) => !(skipImages && a.kind === 'image' && imageData(a)))
    .map((a) => attachmentAsText(a, caps));
  return [m.content, ...extra].filter(Boolean).join('\n\n');
}

/** Images to send natively (attachments + extracted video frames). */
export function nativeImages(m: ChatMessage, caps: ModelCapabilities): ImagePart[] {
  if (!caps.vision) return [];
  const out: ImagePart[] = [];
  for (const a of m.attachments ?? []) {
    const img = imageData(a);
    if (img) out.push(img);
    if (a.kind === 'video') {
      for (const f of (a.frames ?? []).slice(0, 4)) {
        if (existsSync(f)) out.push({ mime: 'image/jpeg', base64: readFileSync(f).toString('base64') });
      }
    }
  }
  return out;
}
