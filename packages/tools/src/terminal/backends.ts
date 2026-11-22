/**
 * Terminal backends: where shell commands actually run.
 *  - local:  child_process on this machine (cwd confined to the path jail)
 *  - docker: `docker run --rm` in a throwaway container with the workdir mounted
 *  - ssh:    `ssh -n user@host` using the configured key (no password prompts)
 * Backends are selected by `tools.terminal.backend` and can be added by plugins
 * via `registerTerminalBackend`.
 */
import { randomBytes } from 'node:crypto';
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

/** Environment variables a shell needs to work normally (no credentials). */
const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'PWD',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSH_AUTH_SOCK', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
];
let passthrough: string[] = [];

/** Configure extra variable names inherited by commands (`tools.terminal.envPassthrough`). */
export function setEnvPassthrough(names: string[]): void {
  passthrough = [...names];
}

/**
 * Scrubbed environment for agent-run commands: only the variables a shell needs (plus configured
 * passthrough), never provider API keys, MERCURY_JWT_SECRET or other secrets from the server env.
 */
export function safeEnv(extra?: Record<string, string>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (passthrough.includes('*')) return { ...(source as Record<string, string>), ...extra };
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...passthrough]) if (source[k] !== undefined) env[k] = source[k]!;
  for (const k of Object.keys(source)) if (k.startsWith('LC_')) env[k] = source[k]!;
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return { ...env, ...extra };
}

/** Spawn argv, collect output (capped), enforce timeout and abort signal. */
export function runArgv(argv: string[], opts: RunCommandOptions & { spawnCwd?: string; onKill?: () => void }): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Own process group (POSIX) so a timeout/abort also kills background grandchildren.
    const group = process.platform !== 'win32';
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.spawnCwd ?? opts.cwd,
      env: safeEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: group,
    });
    const kill = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      opts.onKill?.();
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-MAX_OUTPUT)));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-MAX_OUTPUT)));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
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
  argv(command: string, opts: { cwd: string }, name = `mercury-${randomBytes(6).toString('hex')}`): string[] {
    // Network stays enabled (agents often need package installs); mount only the workdir.
    // Hardening: no privilege gain via setuid, a process cap (fork bombs) and an init reaper.
    return ['docker', 'run', '--rm', '-i', '--init', '--name', name, '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '1g', '--cpus', '1', '-v', `${opts.cwd}:/work`, '-w', '/work', this.image, 'sh', '-lc', command];
  }
  run(command: string, opts: RunCommandOptions): Promise<CommandResult> {
    // Killing the docker CLI does not stop the container: remove it explicitly on timeout/abort.
    const name = `mercury-${randomBytes(6).toString('hex')}`;
    const onKill = () => {
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore', env: safeEnv() }).on('error', () => undefined).unref();
    };
    return runArgv(this.argv(command, opts, name), { ...opts, spawnCwd: process.cwd(), onKill });
  }
}

export class SshBackend implements TerminalBackend {
  name = 'ssh';
  constructor(private host: string, private user?: string, private keyPath?: string) {
    // A host/user beginning with "-" would be parsed by ssh as an option (e.g. -oProxyCommand=…).
    if (host.startsWith('-') || user?.startsWith('-') || !/^[\w.:[\]-]+$/.test(host)) throw new Error(`invalid ssh host: ${host}`);
    if (user !== undefined && !/^[\w.-]+$/.test(user)) throw new Error(`invalid ssh user: ${user}`);
  }
  argv(command: string): string[] {
    const target = this.user ? `${this.user}@${this.host}` : this.host;
    const key = this.keyPath ? ['-i', this.keyPath] : [];
    return ['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...key, '--', target, command];
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
  setEnvPassthrough(t.envPassthrough ?? []);
  if (custom.has(name)) return custom.get(name)!(config);
  if (name === 'docker') return new DockerBackend(t.dockerImage);
  if (name === 'ssh') {
    if (!t.ssh.host) throw new Error('tools.terminal.ssh.host is not configured');
    return new SshBackend(t.ssh.host, t.ssh.user, t.ssh.keyPath);
  }
  return new LocalBackend();
}
