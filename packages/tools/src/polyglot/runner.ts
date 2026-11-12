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
 * The child runs in the tool folder with a scrubbed environment plus MERCURY_WORKDIR.
 */
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { type AnyTool, type ToolRegistry } from '@mercury/core';
import { runArgv } from '../terminal/backends.js';
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
});
export type ToolManifest = z.infer<typeof ManifestSchema>;

const builtDirs = new Set<string>();

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

export function manifestToTool(dir: string, m: ToolManifest): AnyTool {
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
    async execute(args, ctx) {
      await ensureBuilt(dir, m);
      const argv = m.command.map((c, i) => (i === 0 && c.startsWith('./') ? join(dir, c) : c));
      const r = await runArgv(argv, {
        cwd: dir,
        timeoutMs: m.timeoutMs,
        signal: ctx.signal,
        stdin: JSON.stringify(args ?? {}),
        env: { MERCURY_WORKDIR: ctx.workdir, MERCURY_USER: ctx.principal.username },
      });
      if (r.timedOut) return { content: `Tool timed out after ${m.timeoutMs} ms`, isError: true };
      if (r.exitCode !== 0) return { content: truncate(`exit ${r.exitCode}\n${r.stderr || r.stdout}`), isError: true };
      return parseToolOutput(r.stdout);
    },
  };
}

/** Load every `<dir>/<tool>/tool.json`. Invalid manifests are reported, not thrown. */
export function loadPolyglotTools(dirs: string[]): { tools: AnyTool[]; errors: string[] } {
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
        tools.push(manifestToTool(dir, m));
      } catch (err) {
        errors.push(`${file}: ${String(err)}`);
      }
    }
  }
  return { tools, errors };
}

/** Register polyglot tools and hot-reload them when files change. Returns a stop function. */
export function registerPolyglotTools(registry: ToolRegistry, dirs: string[], opts: { watch?: boolean; onError?: (e: string) => void } = {}): () => void {
  const reload = () => {
    for (const t of registry.list()) if (t.source?.startsWith('polyglot:')) registry.unregister(t.name);
    builtDirs.clear();
    const { tools, errors } = loadPolyglotTools(dirs);
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
