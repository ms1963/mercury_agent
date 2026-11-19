/**
 * Voice ports: declarative provider switching, OpenAI-compatible baseUrl/auth behaviour,
 * optional key for self-hosted servers, and test-only mock gating. Fully hermetic — global.fetch
 * is stubbed so no real network call or external binary is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, VoiceService, createSttPort, createTtsPort, type MercuryConfig } from '@mercury/core';

function makeConfig(voice: Record<string, unknown>, dataDir: string): MercuryConfig {
  return ConfigSchema.parse({ dataDir, llm: { defaultModel: 'auto', providers: {}, models: [] }, voice });
}

/** Record fetch calls and return a canned response. */
function stubFetch(handler: (url: string, init: RequestInit) => Response): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    return handler(u, init);
  }) as unknown as typeof fetch;
  return { calls };
}

describe('voice ports', () => {
  let dir: string;
  const savedFetch = global.fetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-voice-'));
  });
  afterEach(() => {
    global.fetch = savedFetch;
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  describe('provider selection / declarative switching', () => {
    it('builds the right port for each configured provider — no code change needed', () => {
      expect(createSttPort(makeConfig({ stt: { provider: 'openai' } }, dir), dir).provider).toBe('openai');
      expect(createSttPort(makeConfig({ stt: { provider: 'openai-compatible' } }, dir), dir).provider).toBe('openai-compatible');
      expect(createSttPort(makeConfig({ stt: { provider: 'whisper' } }, dir), dir).provider).toBe('whisper');
      expect(createTtsPort(makeConfig({ tts: { provider: 'openai' } }, dir), dir).provider).toBe('openai');
      expect(createTtsPort(makeConfig({ tts: { provider: 'edge-tts' } }, dir), dir).provider).toBe('edge-tts');
      expect(createTtsPort(makeConfig({ tts: { provider: 'piper' } }, dir), dir).provider).toBe('piper');
    });

    it('throws a clear error for an unknown provider', () => {
      expect(() => createSttPort(makeConfig({ stt: { provider: 'nope' } }, dir), dir)).toThrow(/Unknown STT provider/);
      expect(() => createTtsPort(makeConfig({ tts: { provider: 'nope' } }, dir), dir)).toThrow(/Unknown TTS provider/);
    });

    it('VoiceService exposes the configured provider ids and switches STT/TTS independently', () => {
      const svc = new VoiceService(makeConfig({ stt: { provider: 'whisper' }, tts: { provider: 'piper' } }, dir));
      expect(svc.sttProvider).toBe('whisper');
      expect(svc.ttsProvider).toBe('piper');
    });
  });

  describe('OpenAI-compatible path (baseUrl + auth)', () => {
    it('STT posts to the CONFIGURED baseUrl with the configured apiKeyEnv and parses the text', async () => {
      process.env.MY_STT_KEY = 'secret-stt';
      const f = stubFetch(() => new Response(JSON.stringify({ text: 'hello world' }), { status: 200 }));
      const svc = new VoiceService(makeConfig({ stt: { provider: 'openai-compatible', baseUrl: 'http://localhost:9999/v1', apiKeyEnv: 'MY_STT_KEY', model: 'whisper-1' } }, dir));
      const audio = join(dir, 'a.wav');
      writeTempWav(audio);
      const text = await svc.transcribe(audio, 'audio/wav');
      expect(text).toBe('hello world');
      expect(f.calls[0]!.url).toBe('http://localhost:9999/v1/audio/transcriptions');
      expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBe('Bearer secret-stt');
    });

    it('TTS posts to the CONFIGURED baseUrl, uses the configured key, and writes the audio file', async () => {
      process.env.MY_TTS_KEY = 'secret-tts';
      const f = stubFetch(() => new Response(Buffer.from('FAKEAUDIO'), { status: 200 }));
      const svc = new VoiceService(makeConfig({ tts: { provider: 'openai-compatible', baseUrl: 'http://localhost:9999/v1', apiKeyEnv: 'MY_TTS_KEY', model: 'my-tts', voice: 'nova', format: 'mp3' } }, dir));
      const res = await svc.speak('say this');
      expect(f.calls[0]!.url).toBe('http://localhost:9999/v1/audio/speech');
      expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBe('Bearer secret-tts');
      const body = JSON.parse(String(f.calls[0]!.init.body));
      expect(body).toMatchObject({ model: 'my-tts', voice: 'nova', input: 'say this', response_format: 'mp3' });
      expect(res.mime).toBe('audio/mpeg');
      expect(existsSync(res.path)).toBe(true);
      expect(readFileSync(res.path).toString()).toBe('FAKEAUDIO');
    });

    it("provider 'openai' defaults to the real OpenAI base URL", async () => {
      process.env.OPENAI_API_KEY = 'k';
      const f = stubFetch(() => new Response(JSON.stringify({ text: 'x' }), { status: 200 }));
      const svc = new VoiceService(makeConfig({ stt: { provider: 'openai' } }, dir));
      const audio = join(dir, 'b.wav');
      writeTempWav(audio);
      await svc.transcribe(audio, 'audio/wav');
      expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    });
  });

  describe('optional key for self-hosted servers', () => {
    it('self-hosted baseUrl works with NO key and sends no Authorization header', async () => {
      delete process.env.OPENAI_API_KEY;
      const fStt = stubFetch(() => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
      const stt = new VoiceService(makeConfig({ stt: { provider: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' } }, dir));
      const audio = join(dir, 'c.wav');
      writeTempWav(audio);
      await expect(stt.transcribe(audio, 'audio/wav')).resolves.toBe('ok');
      expect(new Headers(fStt.calls[0]!.init.headers).get('authorization')).toBeNull();

      const fTts = stubFetch(() => new Response(Buffer.from('AUD'), { status: 200 }));
      const tts = new VoiceService(makeConfig({ tts: { provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' } }, dir));
      await expect(tts.speak('hi')).resolves.toMatchObject({ mime: 'audio/mpeg' });
      expect(new Headers(fTts.calls[0]!.init.headers).get('authorization')).toBeNull();
    });

    it('real OpenAI host WITHOUT a key throws stt_unconfigured / tts_unconfigured', async () => {
      delete process.env.OPENAI_API_KEY;
      const audio = join(dir, 'd.wav');
      writeTempWav(audio);
      const stt = new VoiceService(makeConfig({ stt: { provider: 'openai' } }, dir));
      await expect(stt.transcribe(audio, 'audio/wav')).rejects.toThrow(/OPENAI_API_KEY is not set for STT/);
      const tts = new VoiceService(makeConfig({ tts: { provider: 'openai' } }, dir));
      await expect(tts.speak('hi')).rejects.toThrow(/OPENAI_API_KEY is not set for TTS/);
    });
  });

  describe('mock providers (test-only gating)', () => {
    it('with MERCURY_ENABLE_MOCK=1, mock STT returns a string and mock TTS writes a readable file', async () => {
      process.env.MERCURY_ENABLE_MOCK = '1';
      const svc = new VoiceService(makeConfig({ stt: { provider: 'mock' }, tts: { provider: 'mock' } }, dir));
      expect(await svc.transcribe(join(dir, 'x.wav'), 'audio/wav')).toBe('[mock transcript]');
      const res = await svc.speak('hi');
      expect(existsSync(res.path)).toBe(true);
      const buf = readFileSync(res.path);
      expect(buf.subarray(0, 4).toString()).toBe('RIFF'); // valid WAV
      expect(buf.length).toBeGreaterThan(44);
    });

    it("without the env, provider 'mock' throws (never usable in production)", async () => {
      delete process.env.MERCURY_ENABLE_MOCK;
      const stt = new VoiceService(makeConfig({ stt: { provider: 'mock' } }, dir));
      await expect(stt.transcribe(join(dir, 'x.wav'), 'audio/wav')).rejects.toThrow(/test-only/);
      const tts = new VoiceService(makeConfig({ tts: { provider: 'mock' } }, dir));
      await expect(tts.speak('hi')).rejects.toThrow(/test-only/);
    });
  });
});

function writeTempWav(path: string): void {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.write('WAVE', 8);
  writeFileSync(path, buf);
}
