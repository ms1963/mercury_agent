/**
 * Polyglot tool protocol: a tool is a folder with `tool.json` + an executable in any
 * language. Mercury sends the arguments as JSON on stdin and reads the result from
 * stdout — either JSON `{"content": "...", "isError": false, "data": {...}}` or plain text.
 *
 * tool.json:
 *   { "name", "description", "toolset", "risk", "parameters": <JSON schema>,
 *     "command": ["python3", "main.py"], "build": ["g++", "-o", "main", "main.cpp"],
 *     "timeoutMs": 15000, "requires": ["python3"] }
 *
 * `build` runs once when the first command element (relative file) is missing.
 * The child runs in the tool folder with a scrubbed environment plus MERCURY_WORKDIR — on the host,
 * or in a locked-down container (`tools.polyglotBackend`, tool.json `image`/`network`/`workdir`).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { type AnyTool, type MercuryConfig, type ToolRegistry } from '@mercury/core';
import { runArgv, safeEnv } from '../terminal/backends.js';
import { truncate } from '../util.js';

export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string(),
  toolset: z.string().default('polyglot'),
  risk: z.enum(['safe', 'moderate', 'dangerous']).default('moderate'),
  parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  command: z.array(z.string()).min(1),
  build: z.array(z.string()).optional(),
  timeoutMs: z.number().default(30_000),
  requires: z.array(z.string()).default([]),
  untrustedOutput: z.boolean().default(false),
  /** Container image for the docker backend (default: inferred for python/node commands). */
  image: z.string().optional(),
  /** Docker backend: allow network access (default: none). */
  network: z.boolean().default(false),
  /** Docker backend: how the caller's workdir is mounted at /work (default read-only). */
  workdir: z.enum(['none', 'ro', 'rw']).default('ro'),
});
export type ToolManifest = z.infer<typeof ManifestSchema>;

const builtDirs = new Set<string>();

/**
 * Options deciding how much a tool folder is trusted. A folder the model can write through the
 * file tools (it lies inside a path-jail root) would let it swap the tool's code and then run it on
 * the host, bypassing the host-execution gate. Such tools are therefore marked `hostAccess` (non-admin
 * calls need an admin's approval) and pinned: the folder's content is fingerprinted at load time and
 * a call is refused if any file changed since then.
 */
export interface PolyglotLoadOptions {
  /** True when `dir` is writable by the model (e.g. `(d) => jail.contains(d)`). */
  isWritable?: (dir: string) => boolean;
}

const MAX_FINGERPRINT_FILES = 2000;
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;

/** sha256 over (relative path, content) of every file in `dir` (symlinks by target path). */
export function fingerprintDir(dir: string): string {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      const rel = relative(dir, full);
      if (st.isSymbolicLink()) {
        h.update(`L\0${rel}\0`);
        try {
          h.update(statSync(full).isFile() ? readFileSync(full) : 'dir');
        } catch {
          h.update('dangling');
        }
      } else if (st.isDirectory()) {
        h.update(`D\0${rel}\0`);
        walk(full);
      } else if (st.isFile()) {
        if (++files > MAX_FINGERPRINT_FILES || (bytes += st.size) > MAX_FINGERPRINT_BYTES) throw new Error(`tool folder too large to pin: ${dir}`);
        h.update(`F\0${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0`);
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

async function ensureBuilt(dir: string, m: ToolManifest): Promise<void> {
  if (!m.build || builtDirs.has(dir)) return;
  const target = m.command[0]!;
  const needsBuild = target.startsWith('./') && !existsSync(join(dir, target));
  if (needsBuild) {
    const r = await runArgv(m.build, { cwd: dir, timeoutMs: 180_000 });
    if (r.exitCode !== 0) throw new Error(`build failed for ${m.name}: ${r.stderr || r.stdout}`);
  }
  builtDirs.add(dir);
}

/** Parse a tool's stdout according to the protocol. */
export function parseToolOutput(stdout: string): { content: string; isError?: boolean; data?: unknown } {
  const text = stdout.trim();
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as { content?: unknown; isError?: boolean; data?: unknown };
      if ('content' in obj) return { content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content), isError: obj.isError, data: obj.data };
    } catch {
      /* not JSON → plain text */
    }
  }
  return { content: text };
}

export type PolyglotBackend = 'host' | 'docker';

/** Image for a manifest: explicit `image`, else inferred from a python/node command, else undefined. */
export function polyglotImage(config: MercuryConfig, m: ToolManifest): string | undefined {
  if (m.image) return m.image;
  const cmd = (m.command[0] ?? '').split('/').pop() ?? '';
  if (/^python(3(\.\d+)?)?$/.test(cmd)) return config.tools.executeCode.pythonImage;
  if (cmd === 'node') return config.tools.executeCode.nodeImage;
  return undefined;
}

/**
 * Where a polyglot tool runs (`tools.polyglotBackend`). 'docker' requires an image (explicit or
 * inferred) and fails closed without one; 'auto' uses docker when the terminal backend is docker and
 * an image is known, otherwise the host.
 */
export function resolvePolyglotBackend(config: MercuryConfig, m: ToolManifest): PolyglotBackend | { error: string } {
  const b = config.tools.polyglotBackend ?? 'auto';
  if (b === 'host') return 'host';
  const image = polyglotImage(config, m);
  if (b === 'docker') return image ? 'docker' : { error: `tool ${m.name} has no container image (set "image" in tool.json) and tools.polyglotBackend is docker` };
  return config.tools.terminal.backend === 'docker' && image ? 'docker' : 'host';
}

/** docker run argv for a polyglot tool: folder read-only at /tool, workdir per manifest at /work. */
export function dockerPolyglotArgv(config: MercuryConfig, m: ToolManifest, dir: string, workdir: string, name: string, user: string): string[] {
  const image = polyglotImage(config, m);
  if (!image) throw new Error(`no container image for tool ${m.name}`);
  const mounts = ['-v', `${dir}:/tool:ro`];
  if (m.workdir !== 'none') mounts.push('-v', `${workdir}:/work${m.workdir === 'ro' ? ':ro' : ''}`);
  return [
    'docker', 'run', '--rm', '-i', '--init', '--name', name,
    ...(m.network ? [] : ['--network', 'none']),
    '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '512m', '--cpus', '1', '--user', '65534:65534',
    '-e', 'HOME=/tmp', '-e', 'LANG=C.UTF-8', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '-e', `MERCURY_WORKDIR=${m.workdir === 'none' ? '' : '/work'}`, '-e', `MERCURY_USER=${user}`,
    ...mounts, '-w', '/tool', image, ...m.command,
  ];
}

const DOCKER_CLI_ENV = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
const dockerCliEnv = (): Record<string, string> => Object.fromEntries(DOCKER_CLI_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));

export function manifestToTool(dir: string, m: ToolManifest, opts: PolyglotLoadOptions = {}): AnyTool {
  const writable = !!opts.isWritable?.(dir);
  // Pinned fingerprint of a model-writable folder (re-pinned after Mercury's own build step).
  let pinned = writable ? fingerprintDir(dir) : undefined;
  return {
    name: m.name,
    description: m.description,
    toolset: m.toolset,
    risk: m.risk,
    parameters: m.parameters,
    untrustedOutput: m.untrustedOutput,
    sensitive: m.risk !== 'safe',
    timeoutMs: m.timeoutMs + 5000,
    source: `polyglot:${dir}`,
    ...(writable ? { hostAccess: true } : {}),
    async execute(args, ctx) {
      if (pinned !== undefined) {
        if (fingerprintDir(dir) !== pinned)
          return { content: `Refused: the files of tool ${m.name} changed since it was loaded (its folder is writable by the file tools). Restart Mercury to reload it after reviewing the change.`, isError: true };
        const wasBuilt = builtDirs.has(dir);
        await ensureBuilt(dir, m);
        if (!wasBuilt) pinned = fingerprintDir(dir);
      } else {
        await ensureBuilt(dir, m);
      }
      const backend = resolvePolyglotBackend(ctx.services.config, m);
      if (typeof backend === 'object') return { content: backend.error, isError: true };
      if (backend === 'docker') {
        const name = `mercury-tool-${randomBytes(6).toString('hex')}`;
        const env = dockerCliEnv();
        const r = await runArgv(dockerPolyglotArgv(ctx.services.config, m, dir, ctx.workdir, name, ctx.principal.username), {
          cwd: dir,
          spawnCwd: process.cwd(),
          timeoutMs: m.timeoutMs,
          signal: ctx.signal,
          stdin: JSON.stringify(args ?? {}),
          env,
          // Killing the docker CLI does not stop the container: remove it explicitly.
          onKill: () => spawn('docker', ['rm', '-f', name], { stdio: 'ignore', env: safeEnv(env) }).on('error', () => undefined).unref(),
        });
        if (r.timedOut) return { content: `Tool timed out after ${m.timeoutMs} ms`, isError: true };
        if (r.exitCode !== 0) return { content: truncate(`exit ${r.exitCode}\n${r.stderr || r.stdout}`), isError: true };
        return parseToolOutput(r.stdout);
      }
      const argv = m.command.map((c, i) => (i === 0 && c.startsWith('./') ? join(dir, c) : c));
      const r = await runArgv(argv, {
        cwd: dir,
        timeoutMs: m.timeoutMs,
        signal: ctx.signal,
        stdin: JSON.stringify(args ?? {}),
        // No bytecode caches inside the tool folder (they would also break the pinned fingerprint).
        env: { MERCURY_WORKDIR: ctx.workdir, MERCURY_USER: ctx.principal.username, PYTHONDONTWRITEBYTECODE: '1' },
      });
      if (r.timedOut) return { content: `Tool timed out after ${m.timeoutMs} ms`, isError: true };
      if (r.exitCode !== 0) return { content: truncate(`exit ${r.exitCode}\n${r.stderr || r.stdout}`), isError: true };
      return parseToolOutput(r.stdout);
    },
  };
}

/** Load every `<dir>/<tool>/tool.json`. Invalid manifests are reported, not thrown. */
export function loadPolyglotTools(dirs: string[], opts: PolyglotLoadOptions = {}): { tools: AnyTool[]; errors: string[] } {
  const tools: AnyTool[] = [];
  const errors: string[] = [];
  for (const base of dirs) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      const file = join(dir, 'tool.json');
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      try {
        const m = ManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        tools.push(manifestToTool(dir, m, opts));
      } catch (err) {
        errors.push(`${file}: ${String(err)}`);
      }
    }
  }
  return { tools, errors };
}

/** Register polyglot tools and hot-reload them when files change. Returns a stop function. */
export function registerPolyglotTools(registry: ToolRegistry, dirs: string[], opts: { watch?: boolean; onError?: (e: string) => void } & PolyglotLoadOptions = {}): () => void {
  const reload = () => {
    for (const t of registry.list()) if (t.source?.startsWith('polyglot:')) registry.unregister(t.name);
    builtDirs.clear();
    const { tools, errors } = loadPolyglotTools(dirs, opts);
    tools.forEach((t) => registry.register(t));
    errors.forEach((e) => opts.onError?.(e));
  };
  reload();
  if (!opts.watch) return () => undefined;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  for (const d of dirs.filter((x) => isAbsolute(x) && existsSync(x))) {
    try {
      watchers.push(watch(d, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(reload, 300);
      }));
    } catch {
      /* recursive watch unsupported → no hot reload */
    }
  }
  return () => watchers.forEach((w) => w.close());
}
