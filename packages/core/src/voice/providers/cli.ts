/**
 * Local, fully open-source CLI voice ports — the no-cost / self-hosted options.
 *
 * STT: local `whisper` / whisper.cpp (`provider: 'whisper'` or `'command'` with `voice.stt.command`).
 * TTS: `piper` (offline neural TTS, MIT/Apache ecosystem), `edge-tts` (free), or a custom `command`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { newId } from '../../types/common.js';
import type { SpeechResult, SttPort, TtsPort } from '../ports.js';
import { runTemplate } from '../exec.js';

const run = promisify(execFile);

export class CliSttPort implements SttPort {
  constructor(readonly provider: string, private command: string | undefined, private outDir: string) {}

  async transcribe(path: string, _mime: string): Promise<string> {
    const template = this.command ?? 'whisper {input} --model base --output_format txt --output_dir {outdir}';
    const out = join(this.outDir, newId('stt'));
    const { stdout } = await runTemplate(template, { input: path, output: out, outdir: this.outDir });
    for (const candidate of [`${out}.txt`, join(this.outDir, `${basename(path).replace(/\.[^.]+$/, '')}.txt`)]) {
      if (existsSync(candidate)) {
        const text = readFileSync(candidate, 'utf8');
        unlinkSync(candidate);
        return text.trim();
      }
    }
    return stdout.trim();
  }
}

export class EdgeTtsPort implements TtsPort {
  readonly provider = 'edge-tts';
  constructor(private voice: string, private outDir: string) {}

  async speak(text: string, voice?: string): Promise<SpeechResult> {
    const path = join(this.outDir, `${newId('tts')}.mp3`);
    await run('edge-tts', ['--voice', voice ?? this.voice ?? 'en-US-AriaNeural', '--text', text.slice(0, 4000), '--write-media', path], { timeout: 120_000 });
    return { path, mime: 'audio/mpeg' };
  }
}

export class CliTtsPort implements TtsPort {
  constructor(readonly provider: string, private command: string | undefined, private voice: string, private outDir: string) {}

  async speak(text: string, voice?: string): Promise<SpeechResult> {
    const path = join(this.outDir, `${newId('tts')}.wav`);
    const v = voice ?? this.voice;
    const template = this.command ?? `piper --model ${v ?? 'en_US-lessac-medium'} --output_file {output}`;
    await runTemplate(template, { output: path, text }, text);
    return { path, mime: 'audio/wav' };
  }
}
