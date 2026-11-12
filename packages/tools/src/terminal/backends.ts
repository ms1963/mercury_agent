/**
 * Terminal backends: where shell commands actually run.
 *  - local:  child_process on this machine (cwd confined to the path jail)
 *  - docker: `docker run --rm` in a throwaway container with the workdir mounted
 *  - ssh:    `ssh -n user@host` using the configured key (no password prompts)
 * Backends are selected by `tools.terminal.backend` and can be added by plugins
 * via `registerTerminalBackend`.
 */
import { spawn } from 'node:child_process';
import type { MercuryConfig } from '@mercury/core';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  stdin?: string;
}

export interface TerminalBackend {
  name: string;
  /** Build the argv that runs `command` (used for both foreground and background processes). */
  argv(command: string, opts: { cwd: string }): string[];
  run(command: string, opts: RunCommandOptions): Promise<CommandResult>;
}

const MAX_OUTPUT = 200_000;

/** Spawn argv, collect output (capped), enforce timeout and abort signal. */
export function runArgv(argv: string[], opts: RunCommandOptions & { spawnCwd?: string }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.spawnCwd ?? opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-MAX_OUTPUT)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-MAX_OUTPUT)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export class LocalBackend implements TerminalBackend {
  name = 'local';
  argv(command: string): string[] {
    return ['bash', '-lc', command];
  }
  run(command: string, opts: RunCommandOptions): Promise<CommandResult> {
    return runArgv(this.argv(command), opts);
  }
}

export class DockerBackend implements TerminalBackend {
  name = 'docker';
  constructor(private image: string) {}
  argv(command: string, opts: { cwd: string }): string[] {
    // Network stays enabled (agents often need package installs); mount only the workdir.
    return ['docker', 'run', '--rm', '-i', '--memory', '1g', '--cpus', '1', '-v', `${opts.cwd}:/work`, '-w', '/work', this.image, 'sh', '-lc', command];
  }
  run(command: string, opts: RunCommandOptions): Promise<CommandResult> {
    return runArgv(this.argv(command, opts), { ...opts, spawnCwd: process.cwd() });
  }
}

export class SshBackend implements TerminalBackend {
  name = 'ssh';
  constructor(private host: string, private user?: string, private keyPath?: string) {}
  argv(command: string): string[] {
    const target = this.user ? `${this.user}@${this.host}` : this.host;
    const key = this.keyPath ? ['-i', this.keyPath] : [];
    return ['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...key, target, command];
  }
  run(command: string, opts: RunCommandOptions): Promise<CommandResult> {
    return runArgv(this.argv(command), { ...opts, spawnCwd: process.cwd() });
  }
}

const custom = new Map<string, (config: MercuryConfig) => TerminalBackend>();

export function registerTerminalBackend(name: string, factory: (config: MercuryConfig) => TerminalBackend): void {
  custom.set(name, factory);
}

export function createTerminalBackend(config: MercuryConfig, name = config.tools.terminal.backend): TerminalBackend {
  const t = config.tools.terminal;
  if (custom.has(name)) return custom.get(name)!(config);
  if (name === 'docker') return new DockerBackend(t.dockerImage);
  if (name === 'ssh') {
    if (!t.ssh.host) throw new Error('tools.terminal.ssh.host is not configured');
    return new SshBackend(t.ssh.host, t.ssh.user, t.ssh.keyPath);
  }
  return new LocalBackend();
}
