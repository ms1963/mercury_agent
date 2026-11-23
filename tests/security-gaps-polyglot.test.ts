/**
 * G-01 — polyglot tool folders writable by the file tools. If the model can write a tool's code
 * (folder inside a path-jail root), it could replace the program and run it on the host without
 * the host-execution gate. Such tools are host-gated and tamper-pinned.
 * G-02 — polyglot tools can run in a locked-down container (`tools.polyglotBackend`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyTool, ToolContext, ToolResult } from '@mercury/core';
import { ConfigSchema } from '@mercury/core';
import { dockerPolyglotArgv, fingerprintDir, manifestToTool, ManifestSchema, polyglotImage, resolvePolyglotBackend } from '@mercury/tools';
import { directToolContext } from '@mercury/runtime';
import { makeMercury, tempDir } from './helpers.js';

function makeTool(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'tool.json'),
    JSON.stringify({ name, description: 'echo test', risk: 'safe', command: ['node', 'main.js'], parameters: { type: 'object', properties: { text: { type: 'string' } } } }),
  );
  writeFileSync(join(dir, 'main.js'), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('ok:'+JSON.parse(s).text));\n");
  return dir;
}

/** Execute and normalise the result (tools may return a plain string). */
const call = async (t: AnyTool, args: Record<string, unknown>, c: ToolContext): Promise<ToolResult> => {
  const r = await t.execute(args, c);
  return typeof r === 'string' ? { content: r } : r;
};

const manifest = (dir: string) => ManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'tool.json'), 'utf8')));

describe('G-01 polyglot tools in model-writable folders', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let ws: string;
  beforeAll(async () => {
    ws = tempDir('mercury-poly-ws-');
    makeTool(join(ws, 'tools'), 'g01_jailed');
    const outside = tempDir('mercury-poly-out-');
    makeTool(outside, 'g01_outside');
    ctx = await makeMercury({ tools: { jail: { roots: [ws] }, polyglotDirs: [join(ws, 'tools'), outside], hostAccess: { nonAdmin: 'deny' } } });
  });
  afterAll(async () => ctx?.close());

  it('fingerprint changes when a file changes and is stable otherwise', () => {
    const dir = makeTool(tempDir('mercury-fp-'), 'fp');
    const a = fingerprintDir(dir);
    expect(fingerprintDir(dir)).toBe(a);
    writeFileSync(join(dir, 'main.js'), 'process.stdout.write("pwned")');
    expect(fingerprintDir(dir)).not.toBe(a);
  });

  it('runtime marks tools in jail roots as hostAccess, others not', () => {
    expect(ctx.m.tools.get('g01_jailed')?.hostAccess).toBe(true);
    expect(ctx.m.tools.get('g01_outside')?.hostAccess).toBeFalsy();
  });

  it('a non-admin call of a jailed polyglot tool falls under tools.hostAccess.nonAdmin', async () => {
    ctx.m.users.register('root', 'password-123');
    const eve = ctx.m.users.principalFor(ctx.m.users.register('eve', 'password-123'));
    const exec = (name: string) =>
      ctx.m.executor.execute({ id: `c${Math.random()}`, name, arguments: { text: 'x' } } as never, directToolContext(ctx.m, eve, 'g01'), { untrustedSeen: false, userRequest: 't' } as never);
    const jailed = await exec('g01_jailed');
    expect(jailed.ok).toBe(false);
    expect(jailed.modelContent).toMatch(/runs on the host/);
    const outside = await exec('g01_outside');
    expect(outside.ok).toBe(true);
    expect(outside.modelContent).toBe('ok:x');
  });

  it('a pinned tool runs until its files are modified, then refuses', async () => {
    const dir = makeTool(tempDir('mercury-pin-'), 'g01_pin');
    const tool = manifestToTool(dir, manifest(dir), { isWritable: () => true });
    expect(tool.hostAccess).toBe(true);
    const tctx = directToolContext(ctx.m, await ctx.m.localPrincipal(), 'g01');
    const ok = await call(tool, { text: 'hi' }, tctx);
    expect(ok.content).toBe('ok:hi');
    writeFileSync(join(dir, 'main.js'), 'process.stdout.write("pwned")');
    const bad = await call(tool, { text: 'hi' }, tctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/changed since it was loaded/);
    // A newly planted file is detected as well.
    const dir2 = makeTool(tempDir('mercury-pin2-'), 'g01_pin2');
    const t2 = manifestToTool(dir2, manifest(dir2), { isWritable: () => true });
    writeFileSync(join(dir2, 'extra.js'), '1');
    expect((await call(t2, { text: 'x' }, tctx)).isError).toBe(true);
  });

  it('tools outside the jail are not pinned (admin-installed code may be updated in place)', async () => {
    const dir = makeTool(tempDir('mercury-nopin-'), 'g01_nopin');
    const tool = manifestToTool(dir, manifest(dir), { isWritable: () => false });
    const tctx = directToolContext(ctx.m, await ctx.m.localPrincipal(), 'g01');
    writeFileSync(join(dir, 'main.js'), 'process.stdout.write("v2")');
    expect((await call(tool, { text: 'x' }, tctx)).content).toBe('v2');
  });
});

describe('G-02 polyglot docker backend', () => {
  const cfg = (polyglotBackend: string, terminal = 'local') => ConfigSchema.parse({ tools: { polyglotBackend, terminal: { backend: terminal } } });
  const m = (o: Record<string, unknown>) => ManifestSchema.parse({ name: 't', description: 'd', command: ['python3', 'main.py'], ...o });

  it('resolves the backend and the image', () => {
    expect(resolvePolyglotBackend(cfg('auto'), m({}))).toBe('host');
    expect(resolvePolyglotBackend(cfg('auto', 'docker'), m({}))).toBe('docker');
    expect(resolvePolyglotBackend(cfg('auto', 'docker'), m({ command: ['./main'] }))).toBe('host');
    expect(resolvePolyglotBackend(cfg('docker'), m({ command: ['./main'] }))).toMatchObject({ error: expect.stringMatching(/no container image/) });
    expect(resolvePolyglotBackend(cfg('docker'), m({ command: ['./main'], image: 'gcc:14' }))).toBe('docker');
    expect(resolvePolyglotBackend(cfg('host', 'docker'), m({}))).toBe('host');
    expect(polyglotImage(cfg('docker'), m({ command: ['node', 'x.mjs'] }))).toBe('node:22-slim');
    expect(polyglotImage(cfg('docker'), m({ command: ['/usr/bin/python3.12', 'x.py'] }))).toBe('python:3.12-slim');
  });

  it('builds a locked-down docker argv', () => {
    const a = dockerPolyglotArgv(cfg('docker'), m({}), '/opt/t', '/home/w', 'n1', 'eve');
    const s = a.join(' ');
    for (const f of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 65534:65534', '-v /opt/t:/tool:ro', '-v /home/w:/work:ro', '-w /tool', 'MERCURY_USER=eve'])
      expect(s).toContain(f);
    expect(a.slice(-3)).toEqual(['python:3.12-slim', 'python3', 'main.py']);
    const net = dockerPolyglotArgv(cfg('docker'), m({ network: true, workdir: 'rw' }), '/opt/t', '/home/w', 'n2', 'eve').join(' ');
    expect(net).not.toContain('--network none');
    expect(net).toContain('-v /home/w:/work ');
    expect(dockerPolyglotArgv(cfg('docker'), m({ workdir: 'none' }), '/opt/t', '/home/w', 'n3', 'eve').join(' ')).not.toContain('/work:');
  });

  it('executes through the docker CLI with stdin args (fake docker on PATH)', async () => {
    const bin = tempDir('mercury-fakedocker-');
    // Fake docker: echoes its argv and the stdin payload as the tool result.
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nin=$(cat)\nprintf \'{"content":"%s | %s"}\' "$*" "$(echo $in | tr -d \'"\')"\n');
    chmodSync(join(bin, 'docker'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const ctx = await makeMercury({ tools: { polyglotBackend: 'docker' } });
    try {
      const dir = makeTool(tempDir('mercury-dock-'), 'g02_dock');
      const tool = manifestToTool(dir, manifest(dir));
      const r = await call(tool, { text: 'hi' }, directToolContext(ctx.m, await ctx.m.localPrincipal(), 'g02'));
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('run --rm -i --init');
      expect(r.content).toContain('--network none');
      expect(r.content).toContain(`${dir}:/tool:ro`);
      expect(r.content).toContain('node:22-slim node main.js');
      expect(r.content).toContain('text:hi');
    } finally {
      process.env.PATH = oldPath;
      await ctx.close();
    }
  });
});
