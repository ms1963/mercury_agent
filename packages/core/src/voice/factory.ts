/**
 * Config-driven factory that builds the right STT/TTS port from `config.voice.*`.
 *
 * This is what makes swapping commercial ↔ open-source a single declarative change: change
 * `voice.stt.provider` / `voice.tts.provider` (and optionally `baseUrl`) and the correct port is
 * constructed — no code edits. Mirrors the LLM ProviderRegistry philosophy.
 */
import type { MercuryConfig } from '../config/schema.js';
import { MercuryError } from '../types/common.js';
import type { SttPort, TtsPort } from './ports.js';
import { CliSttPort, CliTtsPort, EdgeTtsPort } from './providers/cli.js';
import { MockSttPort, MockTtsPort } from './providers/mock.js';
import { OPENAI_DEFAULT_BASE_URL, OpenAICompatibleSttPort, OpenAICompatibleTtsPort } from './providers/openai.js';

function mockEnabled(): boolean {
  return process.env.MERCURY_ENABLE_MOCK === '1';
}

export function createSttPort(config: MercuryConfig, outDir: string): SttPort {
  const stt = config.voice.stt;
  switch (stt.provider) {
    case 'mock':
      if (!mockEnabled()) throw new MercuryError("STT provider 'mock' is test-only (set MERCURY_ENABLE_MOCK=1)", 'stt_unconfigured', 'voice');
      return new MockSttPort();
    case 'openai':
    case 'openai-compatible':
      return new OpenAICompatibleSttPort({
        provider: stt.provider,
        baseUrl: stt.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
        apiKeyEnv: stt.apiKeyEnv,
        model: stt.model,
        format: stt.format,
      });
    case 'whisper':
    case 'command':
      return new CliSttPort(stt.provider, stt.command, outDir);
    default:
      throw new MercuryError(`Unknown STT provider ${stt.provider}`, 'stt_unconfigured', 'voice');
  }
}

export function createTtsPort(config: MercuryConfig, outDir: string): TtsPort {
  const tts = config.voice.tts;
  switch (tts.provider) {
    case 'mock':
      if (!mockEnabled()) throw new MercuryError("TTS provider 'mock' is test-only (set MERCURY_ENABLE_MOCK=1)", 'tts_unconfigured', 'voice');
      return new MockTtsPort(outDir);
    case 'openai':
    case 'openai-compatible':
      return new OpenAICompatibleTtsPort({
        provider: tts.provider,
        baseUrl: tts.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
        apiKeyEnv: tts.apiKeyEnv,
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
        outDir,
      });
    case 'edge-tts':
      return new EdgeTtsPort(tts.voice, outDir);
    case 'piper':
    case 'command':
      return new CliTtsPort(tts.provider, tts.command, tts.voice, outDir);
    default:
      throw new MercuryError(`Unknown TTS provider ${tts.provider}`, 'tts_unconfigured', 'voice');
  }
}
