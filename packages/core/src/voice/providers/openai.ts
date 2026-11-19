/**
 * OpenAI-compatible STT/TTS ports.
 *
 * These talk to the OpenAI audio API shape: `POST {baseUrl}/audio/transcriptions` and
 * `POST {baseUrl}/audio/speech`. Because `baseUrl` and the API-key env var are both configurable,
 * the SAME code path serves the commercial OpenAI API (default baseUrl) and any self-hosted
 * open-source server that exposes those routes (faster-whisper-server, Speaches, openedai-speech,
 * Kokoro-FastAPI, ...). Switching from commercial to open source is just a baseUrl change.
 *
 * Many self-hosted servers ignore the Authorization header or accept any string, so the key is
 * required ONLY for the real OpenAI host; for any other baseUrl it is optional (and still sent
 * when present).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MercuryError, newId } from '../../types/common.js';
import type { SpeechResult, SttPort, TtsPort } from '../ports.js';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** True when the base URL points at the real, paid OpenAI API (so a key is mandatory). */
export function isOpenAIHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === 'api.openai.com';
  } catch {
    return false;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/wave',
};

export interface OpenAISttOptions {
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  format?: string;
}

export class OpenAICompatibleSttPort implements SttPort {
  readonly provider: string;
  constructor(private opts: OpenAISttOptions) {
    this.provider = opts.provider;
  }

  async transcribe(path: string, mime: string): Promise<string> {
    const key = process.env[this.opts.apiKeyEnv];
    if (!key && isOpenAIHost(this.opts.baseUrl)) {
      throw new MercuryError(`${this.opts.apiKeyEnv} is not set for STT`, 'stt_unconfigured', 'voice');
    }
    const form = new FormData();
    form.append('file', new Blob([readFileSync(path)], { type: mime }), basename(path));
    form.append('model', this.opts.model);
    if (this.opts.format) form.append('response_format', this.opts.format);
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(joinUrl(this.opts.baseUrl, 'audio/transcriptions'), { method: 'POST', headers, body: form });
    if (!res.ok) throw new MercuryError(`STT failed: ${res.status} ${await res.text()}`, 'stt_failed', 'voice');
    // `response_format: text` returns a raw string; the default JSON returns { text }.
    if (this.opts.format === 'text') return (await res.text()).trim();
    return ((await res.json()) as { text: string }).text;
  }
}

export interface OpenAITtsOptions {
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  voice: string;
  format?: string;
  outDir: string;
}

export class OpenAICompatibleTtsPort implements TtsPort {
  readonly provider: string;
  constructor(private opts: OpenAITtsOptions) {
    this.provider = opts.provider;
  }

  async speak(text: string, voice?: string): Promise<SpeechResult> {
    const key = process.env[this.opts.apiKeyEnv];
    if (!key && isOpenAIHost(this.opts.baseUrl)) {
      throw new MercuryError(`${this.opts.apiKeyEnv} is not set for TTS`, 'tts_unconfigured', 'voice');
    }
    const format = this.opts.format ?? 'mp3';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(joinUrl(this.opts.baseUrl, 'audio/speech'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.opts.model, voice: voice ?? this.opts.voice, input: text.slice(0, 4000), response_format: format }),
    });
    if (!res.ok) throw new MercuryError(`TTS failed: ${res.status}`, 'tts_failed', 'voice');
    const path = join(this.opts.outDir, `${newId('tts')}.${format}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    return { path, mime: AUDIO_MIME[format] ?? 'application/octet-stream' };
  }
}
