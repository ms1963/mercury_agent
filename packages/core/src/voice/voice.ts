/**
 * Voice: speech-to-text and text-to-speech behind small provider interfaces.
 *
 * STT providers: mock | openai (Whisper API) | whisper (local CLI) | command (custom CLI)
 * TTS providers: mock | openai | edge-tts | piper | command
 *
 * Command templates may use {input} and {output} placeholders, e.g.
 *   stt.command: "whisper-cli -m ggml-base.bin -f {input} -otxt -of {output}"
 *   tts.command: "piper --model en_US-lessac-medium.onnx --output_file {output}"   (text on stdin)
 * Wake-word: `voice.wakeWord.command` is an external detector process that prints a
 * line whenever the wake word is heard; `startWakeWord()` turns lines into callbacks.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { MercuryConfig } from '../config/schema.js';
import { MercuryError, newId } from '../types/common.js';

const run = promisify(execFile);

export interface SpeechResult {
  path: string;
  mime: string;
}

export class VoiceService {
  private outDir: string;

  constructor(private config: MercuryConfig) {
    this.outDir = join(config.dataDir, 'attachments', 'tts');
    mkdirSync(this.outDir, { recursive: true });
  }

  get sttProvider(): string {
    return this.config.voice.stt.provider;
  }
  get ttsProvider(): string {
    return this.config.voice.tts.provider;
  }

  async transcribe(path: string, mime = 'audio/wav'): Promise<string> {
    const stt = this.config.voice.stt;
    switch (stt.provider) {
      case 'mock':
        return `[mock transcript of ${basename(path)}]`;
      case 'openai': {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new MercuryError('OPENAI_API_KEY is not set for STT', 'stt_unconfigured', 'voice');
        const form = new FormData();
        form.append('file', new Blob([readFileSync(path)], { type: mime }), basename(path));
        form.append('model', stt.model ?? 'whisper-1');
        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
        if (!res.ok) throw new MercuryError(`STT failed: ${res.status} ${await res.text()}`, 'stt_failed', 'voice');
        return ((await res.json()) as { text: string }).text;
      }
      case 'whisper':
      case 'command': {
        const template = stt.command ?? 'whisper {input} --model base --output_format txt --output_dir {outdir}';
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
      default:
        throw new MercuryError(`Unknown STT provider ${stt.provider}`, 'stt_unconfigured', 'voice');
    }
  }

  async speak(text: string, voice?: string): Promise<SpeechResult> {
    const tts = this.config.voice.tts;
    const v = voice ?? tts.voice;
    switch (tts.provider) {
      case 'mock': {
        const path = join(this.outDir, `${newId('tts')}.wav`);
        writeFileSync(path, silentWav(Math.min(3, 0.3 + text.length / 40)));
        return { path, mime: 'audio/wav' };
      }
      case 'openai': {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new MercuryError('OPENAI_API_KEY is not set for TTS', 'tts_unconfigured', 'voice');
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v ?? 'alloy', input: text.slice(0, 4000) }),
        });
        if (!res.ok) throw new MercuryError(`TTS failed: ${res.status}`, 'tts_failed', 'voice');
        const path = join(this.outDir, `${newId('tts')}.mp3`);
        writeFileSync(path, Buffer.from(await res.arrayBuffer()));
        return { path, mime: 'audio/mpeg' };
      }
      case 'edge-tts': {
        const path = join(this.outDir, `${newId('tts')}.mp3`);
        await run('edge-tts', ['--voice', v ?? 'en-US-AriaNeural', '--text', text.slice(0, 4000), '--write-media', path], { timeout: 120_000 });
        return { path, mime: 'audio/mpeg' };
      }
      case 'piper':
      case 'command': {
        const path = join(this.outDir, `${newId('tts')}.wav`);
        const template = tts.command ?? `piper --model ${v ?? 'en_US-lessac-medium'} --output_file {output}`;
        await runTemplate(template, { output: path, text }, text);
        return { path, mime: 'audio/wav' };
      }
      default:
        throw new MercuryError(`Unknown TTS provider ${tts.provider}`, 'tts_unconfigured', 'voice');
    }
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

function splitArgs(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ''));
}

/** Run a command template; placeholders are substituted per argument (no shell). */
async function runTemplate(template: string, vars: Record<string, string>, stdin?: string): Promise<{ stdout: string }> {
  const [bin, ...args] = splitArgs(template).map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''));
  return new Promise((resolve, reject) => {
    const child = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => reject(new MercuryError(`Voice command failed: ${e.message}`, 'voice_command', 'voice')));
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve({ stdout }) : reject(new MercuryError(`Voice command exited ${code}: ${stderr.slice(0, 500)}`, 'voice_command', 'voice'));
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Minimal silent 16 kHz mono WAV (mock TTS output). */
export function silentWav(seconds: number): Buffer {
  const rate = 16000;
  const samples = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}
