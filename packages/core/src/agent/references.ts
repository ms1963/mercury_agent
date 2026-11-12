/**
 * Inline context references in user messages (Hermes syntax):
 *   @file:path/to/file   @folder:src   @diff   @staged   @url:https://...
 * Each reference is expanded into an attached context block. Files are read through
 * the path jail; URLs are fetched through the SSRF guard and marked untrusted.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { PathJail } from '../security/paths.js';
import { safeFetch } from '../security/ssrf.js';
import { spotlight } from '../security/injection.js';
import { errorMessage, truncate } from '../types/common.js';

const run = promisify(execFile);
const REF_RE = /@(file|folder|url):(\S+)|@(diff|staged)\b/g;

export interface ExpandedReferences {
  text: string;
  blocks: string[];
  untrusted: boolean;
}

export async function expandReferences(input: string, opts: { workdir: string; jail: PathJail; allowPrivateNetworks?: boolean }): Promise<ExpandedReferences> {
  const blocks: string[] = [];
  let untrusted = false;
  for (const m of input.matchAll(REF_RE)) {
    const kind = m[1] ?? m[3]!;
    const arg = m[2] ?? '';
    try {
      if (kind === 'file') {
        const p = opts.jail.check(arg, opts.workdir);
        blocks.push(`<file path="${arg}">\n${truncate(readFileSync(p, 'utf8'), 30_000)}\n</file>`);
      } else if (kind === 'folder') {
        const p = opts.jail.check(arg, opts.workdir);
        blocks.push(`<folder path="${arg}">\n${listTree(p, 3).join('\n')}\n</folder>`);
      } else if (kind === 'diff' || kind === 'staged') {
        const args = kind === 'staged' ? ['diff', '--staged'] : ['diff'];
        const { stdout } = await run('git', args, { cwd: opts.workdir, maxBuffer: 5_000_000 });
        blocks.push(`<git-${kind}>\n${truncate(stdout || '(no changes)', 30_000)}\n</git-${kind}>`);
      } else if (kind === 'url') {
        const res = await safeFetch(arg, {}, { allowPrivate: opts.allowPrivateNetworks });
        const text = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        blocks.push(spotlight(truncate(text, 20_000), `url:${arg}`));
        untrusted = true;
      }
    } catch (err) {
      blocks.push(`<reference-error ref="${m[0]}">${errorMessage(err)}</reference-error>`);
    }
  }
  if (!blocks.length) return { text: input, blocks, untrusted };
  return { text: `${input}\n\n--- Referenced context ---\n${blocks.join('\n\n')}`, blocks, untrusted };
}

function listTree(root: string, depth: number, prefix = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root).filter((n) => !n.startsWith('.') && n !== 'node_modules').slice(0, 200)) {
    const p = join(root, e);
    const isDir = statSync(p).isDirectory();
    out.push(`${relative(prefix, p)}${isDir ? '/' : ''}`);
    if (isDir && depth > 1) out.push(...listTree(p, depth - 1, prefix));
  }
  return out;
}
