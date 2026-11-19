/**
 * Voice: speech-to-text and text-to-speech behind small, swappable provider ports.
 *
 * VoiceService is a thin facade. The actual work is delegated to an {@link SttPort} / {@link TtsPort}
 * built by the config-driven factory (see ./factory.ts), so STT and TTS can each be switched between
 * a commercial cloud API and an open-source/self-hosted server with a single config change:
 *
 *   STT providers: openai | openai-compatible (OpenAI-style /audio/transcriptions; point baseUrl at a
 *                  self-hosted server) | whisper | command (local CLI) | mock (test-only)
 *   TTS providers: openai | openai-compatible (OpenAI-style /audio/speech) | edge-tts | piper |
 *                  command (local CLI) | mock (test-only)
 *
 * Command templates may use {input}, {output}, {outdir} and {text} placeholders, e.g.
 *   stt.command: "whisper-cli -m ggml-base.bin -f {input} -otxt -of {output}"
 *   tts.command: "piper --model en_US-lessac-medium.onnx --output_file {output}"   (text on stdin)
 * Wake-word: `voice.wakeWord.command` is an external detector process that prints a line whenever the
 * wake word is heard; `startWakeWord()` turns lines into callbacks.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MercuryConfig } from '../config/schema.js';
import { splitArgs } from './exec.js';
import { createSttPort, createTtsPort } from './factory.js';
import type { SpeechResult, SttPort, TtsPort } from './ports.js';

export class VoiceService {
  private outDir: string;
  private _stt?: SttPort;
  private _tts?: TtsPort;

  constructor(private config: MercuryConfig) {
    this.outDir = join(config.dataDir, 'attachments', 'tts');
    mkdirSync(this.outDir, { recursive: true });
  }

  // Ports are built lazily so an invalid/test-only provider only fails when voice is actually used
  // (and the gateway's transcribe try/catch keeps working), not at runtime construction time.
  private get stt(): SttPort {
    return (this._stt ??= createSttPort(this.config, this.outDir));
  }
  private get tts(): TtsPort {
    return (this._tts ??= createTtsPort(this.config, this.outDir));
  }

  get sttProvider(): string {
    return this.config.voice.stt.provider;
  }
  get ttsProvider(): string {
    return this.config.voice.tts.provider;
  }

  async transcribe(path: string, mime = 'audio/wav'): Promise<string> {
    return this.stt.transcribe(path, mime);
  }

  async speak(text: string, voice?: string): Promise<SpeechResult> {
    return this.tts.speak(text, voice);
  }

  /** Start the external wake-word detector; returns a stop function (or undefined if not configured). */
  startWakeWord(onWake: (line: string) => void): (() => void) | undefined {
    const cmd = this.config.voice.wakeWord.command;
    if (!cmd) return undefined;
    const [bin, ...args] = splitArgs(cmd);
    const child: ChildProcess = spawn(bin!, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(onWake));
    return () => child.kill();
  }
}
