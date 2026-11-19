/** Voice preset tests: ensures the one-command STT/TTS swap resolves to valid, complete config. */
import { describe, expect, it } from 'vitest';
import { STT_PRESETS, TTS_PRESETS, resolveVoicePreset, voicePresets, ConfigSchema } from '@mercury/core';

describe('voice presets', () => {
  it('exposes both offline open-source and online commercial options for each kind', () => {
    for (const table of [STT_PRESETS, TTS_PRESETS]) {
      const vals = Object.values(table);
      expect(vals.some((p) => p.reach === 'offline' && p.openSource)).toBe(true);
      expect(vals.some((p) => p.reach === 'online')).toBe(true);
    }
    // The historical commercial default stays available under its canonical name.
    expect(STT_PRESETS.openai.openSource).toBe(false);
    expect(TTS_PRESETS.openai.openSource).toBe(false);
    // Flagship open-source self-hosted options are present.
    expect(STT_PRESETS.speaches.config.provider).toBe('openai-compatible');
    expect(TTS_PRESETS.kokoro.config.provider).toBe('openai-compatible');
    expect(STT_PRESETS.whisper.config.provider).toBe('whisper');
    expect(TTS_PRESETS.piper.config.provider).toBe('piper');
  });

  it('resolveVoicePreset returns a fresh copy (callers cannot mutate the shared table)', () => {
    const a = resolveVoicePreset('tts', 'openai');
    a.provider = 'tampered';
    expect(TTS_PRESETS.openai.config.provider).toBe('openai');
    expect(resolveVoicePreset('tts', 'openai').provider).toBe('openai');
  });

  it('throws a helpful error listing valid names for an unknown preset', () => {
    expect(() => resolveVoicePreset('stt', 'nope')).toThrow(/Unknown STT preset "nope".*openai/s);
  });

  it('voicePresets(kind) selects the right table', () => {
    expect(voicePresets('stt')).toBe(STT_PRESETS);
    expect(voicePresets('tts')).toBe(TTS_PRESETS);
  });

  it('every preset block is accepted by the config schema (valid on reload)', () => {
    // Each preset is a complete voice.<kind> block; the parsed config must validate and round-trip.
    for (const name of Object.keys(STT_PRESETS)) {
      const cfg = ConfigSchema.parse({ voice: { stt: resolveVoicePreset('stt', name) } });
      expect(cfg.voice.stt.provider).toBe(STT_PRESETS[name]!.config.provider);
    }
    for (const name of Object.keys(TTS_PRESETS)) {
      const cfg = ConfigSchema.parse({ voice: { tts: resolveVoicePreset('tts', name) } });
      expect(cfg.voice.tts.provider).toBe(TTS_PRESETS[name]!.config.provider);
    }
  });
});
