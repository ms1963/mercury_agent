/**
 * Test-only mock voice ports. Like the LLM MockProvider, these exist SOLELY for the test suite and
 * are selectable only when MERCURY_ENABLE_MOCK === '1' (enforced by the factory). They never touch
 * the network or external binaries, so the voice paths can be exercised hermetically.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../types/common.js';
import type { SpeechResult, SttPort, TtsPort } from '../ports.js';

export class MockSttPort implements SttPort {
  readonly provider = 'mock';
  async transcribe(_path: string, _mime: string): Promise<string> {
    return '[mock transcript]';
  }
}

export class MockTtsPort implements TtsPort {
  readonly provider = 'mock';
  constructor(private outDir: string) {}

  async speak(_text: string, _voice?: string): Promise<SpeechResult> {
    const path = join(this.outDir, `${newId('tts')}.wav`);
    writeFileSync(path, minimalWav());
    return { path, mime: 'audio/wav' };
  }
}

/** A tiny but valid 8kHz mono 16-bit PCM WAV containing a handful of silent samples. */
function minimalWav(samples = 8): Buffer {
  const sampleRate = 8000;
  const dataLen = samples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}
