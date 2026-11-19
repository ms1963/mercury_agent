/**
 * Named voice presets — the one-command way to swap the STT or TTS stack.
 *
 * Each preset is a complete, declarative `voice.stt` / `voice.tts` config block. Applying one
 * (via `mercury voice use stt|tts <name>`) writes the whole block through `setConfigValue`, so a
 * single command moves between a commercial cloud API and a self-hosted / offline open-source
 * engine — no code edits, no partial state left behind.
 *
 * `reach`:  'online'  → needs the internet / a cloud account.
 *           'offline' → runs locally with no network (self-hosted server or local CLI).
 * The patch shape matches the Zod schema in ../config/schema.ts exactly, so a written block is
 * always valid on reload. This module is pure data + two helpers: trivial to unit-test and extend.
 */

export type VoiceKind = 'stt' | 'tts';

export interface VoicePreset {
  /** One-line description shown by `mercury voice presets`. */
  readonly description: string;
  /** Whether the preset needs network access (cloud) or runs fully local. */
  readonly reach: 'online' | 'offline';
  /** Open-source engine vs. commercial service. */
  readonly openSource: boolean;
  /** The exact `voice.stt` / `voice.tts` config block this preset writes. */
  readonly config: Record<string, unknown>;
}

/** Speech-to-text presets. */
export const STT_PRESETS: Record<string, VoicePreset> = {
  // Commercial OpenAI cloud (the historical default).
  openai: {
    description: 'OpenAI cloud Whisper (commercial, needs OPENAI_API_KEY)',
    reach: 'online',
    openSource: false,
    config: { provider: 'openai', model: 'whisper-1', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  // Self-hosted, OpenAI-compatible open-source server (faster-whisper behind Speaches).
  speaches: {
    description: 'Self-hosted faster-whisper via Speaches (open source, OpenAI-compatible, offline)',
    reach: 'offline',
    openSource: true,
    config: { provider: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  // Fully local open-source CLI (OpenAI Whisper / whisper.cpp), zero network.
  whisper: {
    description: 'Local whisper / whisper.cpp CLI (open source, fully offline, no server)',
    reach: 'offline',
    openSource: true,
    config: { provider: 'whisper' },
  },
};

/** Text-to-speech presets. */
export const TTS_PRESETS: Record<string, VoicePreset> = {
  // Commercial OpenAI cloud (the historical default).
  openai: {
    description: 'OpenAI cloud TTS (commercial, needs OPENAI_API_KEY)',
    reach: 'online',
    openSource: false,
    config: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  // Self-hosted openedai-speech: a drop-in open-source OpenAI /audio/speech server.
  openedai: {
    description: 'Self-hosted openedai-speech (open source, OpenAI-compatible, offline)',
    reach: 'offline',
    openSource: true,
    config: { provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'tts-1', voice: 'alloy', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  // Self-hosted Kokoro-FastAPI: an OpenAI-compatible server around the Kokoro open-weight model.
  kokoro: {
    description: 'Self-hosted Kokoro-FastAPI (open source, OpenAI-compatible, offline)',
    reach: 'offline',
    openSource: true,
    config: { provider: 'openai-compatible', baseUrl: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_sky', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  // Fully local open-source neural CLI (Piper), zero network.
  piper: {
    description: 'Local Piper neural TTS CLI (open source, fully offline, no server)',
    reach: 'offline',
    openSource: true,
    config: { provider: 'piper', voice: 'en_US-lessac-medium' },
  },
  // Free Microsoft Edge voices over the edge-tts CLI (no key, needs network).
  'edge-tts': {
    description: 'edge-tts free online voices (no key, open-source client, needs network)',
    reach: 'online',
    openSource: true,
    config: { provider: 'edge-tts', voice: 'en-US-AriaNeural' },
  },
};

/** The preset table for a given kind. */
export function voicePresets(kind: VoiceKind): Record<string, VoicePreset> {
  return kind === 'stt' ? STT_PRESETS : TTS_PRESETS;
}

/**
 * Resolve a preset name to the config block to write, or throw a clear error listing valid names.
 * Returns a shallow copy so callers can never mutate the shared preset table.
 */
export function resolveVoicePreset(kind: VoiceKind, name: string): Record<string, unknown> {
  const table = voicePresets(kind);
  const preset = table[name];
  if (!preset) {
    throw new Error(`Unknown ${kind.toUpperCase()} preset "${name}". Available: ${Object.keys(table).join(', ')}`);
  }
  return { ...preset.config };
}
