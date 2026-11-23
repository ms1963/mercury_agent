/**
 * G-01 — polyglot tool folders writable by the file tools. If the model can write a tool's code
 * (folder inside a path-jail root), it could replace the program and run it on the host without
 * the host-execution gate. Such tools are host-gated and tamper-pinned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyTool, ToolContext, ToolResult } from '@mercury/core';
import { fingerprintDir, manifestToTool, ManifestSchema } from '@mercury/tools';
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
