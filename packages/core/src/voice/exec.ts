/**
 * Small process helpers shared by the CLI-based voice ports and the wake-word detector.
 * Command templates substitute {input} / {output} / {outdir} / {text} per argument (no shell).
 */
import { spawn } from 'node:child_process';
import { MercuryError } from '../types/common.js';

export function splitArgs(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ''));
}

/** Run a command template; placeholders are substituted per argument (no shell). */
export async function runTemplate(template: string, vars: Record<string, string>, stdin?: string): Promise<{ stdout: string }> {
  const [bin, ...args] = splitArgs(template).map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''));
  return new Promise((resolve, reject) => {
    const child = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      const msg =
        e.code === 'ENOENT'
          ? `Voice command failed: '${bin}' was not found. Install it and make sure it is on the PATH of the process running 'mercury serve'. On macOS, apps started from the GUI/launchd do not inherit your shell PATH, so Homebrew binaries in /opt/homebrew/bin may be missing — start the server from a terminal, or set an absolute path in voice.stt.command / voice.tts.command (e.g. /opt/homebrew/bin/${bin}).`
          : `Voice command failed: ${e.message}`;
      reject(new MercuryError(msg, 'voice_command', 'voice'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new MercuryError(`Voice command exited ${code}: ${stderr.slice(0, 500)}`, 'voice_command', 'voice'));
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}
