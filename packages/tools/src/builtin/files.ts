/**
 * File tools (toolset "files"). All paths go through the path jail; every write is
 * snapshotted first so `/rollback` can undo agent edits.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { defineTool, type AnyTool } from '@mercury/core';
import { bool, num, params, resolvePath, snapshot, str, truncate } from '../util.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.venv', '__pycache__']);

/** Recursively walk a directory (skipping heavy folders), yielding file paths. */
export function* walk(dir: string, maxFiles = 5000): Generator<string> {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORED.has(e)) continue;
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else {
        yield full;
        if (++count >= maxFiles) return;
      }
    }
  }
}

/** Convert a simple glob (`**`, `*`, `?`) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const readFile = defineTool<{ path: string; offset?: number; limit?: number }>({
  name: 'read_file',
  description: 'Read a text file. Optionally pass offset (1-based line) and limit (number of lines).',
  toolset: 'files',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ path: str('File path'), offset: num('First line (1-based)'), limit: num('Max lines') }, ['path']),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    const lines = readFileSync(p, 'utf8').split('\n');
    const start = Math.max(0, (a.offset ?? 1) - 1);
    const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
    return truncate(slice.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`).join('\n'));
  },
});

export const writeFile = defineTool<{ path: string; content: string; append?: boolean }>({
  name: 'write_file',
  description: 'Create or overwrite a text file (or append with append=true). Creates parent folders.',
  toolset: 'files',
  risk: 'moderate',
  sensitive: true,
  parameters: params({ path: str('File path'), content: str('Full file content'), append: bool('Append instead of overwrite') }, ['path', 'content']),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    snapshot(ctx, p, `write_file ${a.path}`);
    mkdirSync(dirname(p), { recursive: true });
    const content = a.append && existsSync(p) ? readFileSync(p, 'utf8') + a.content : a.content;
    writeFileSync(p, content);
    return `Wrote ${content.length} chars to ${relative(ctx.workdir, p) || p}`;
  },
});

export const editFile = defineTool<{ path: string; old_text: string; new_text: string; replace_all?: boolean }>({
  name: 'edit_file',
  description: 'Replace an exact text fragment in a file (patch). old_text must match exactly once unless replace_all=true.',
  toolset: 'files',
  risk: 'moderate',
  sensitive: true,
  parameters: params(
    { path: str('File path'), old_text: str('Exact text to replace'), new_text: str('Replacement text'), replace_all: bool('Replace every occurrence') },
    ['path', 'old_text', 'new_text'],
  ),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    const text = readFileSync(p, 'utf8');
    const count = text.split(a.old_text).length - 1;
    if (count === 0) return { content: 'old_text not found in file. Read the file again and copy the text exactly.', isError: true };
    if (count > 1 && !a.replace_all) return { content: `old_text matches ${count} times; add more context or set replace_all=true.`, isError: true };
    snapshot(ctx, p, `edit_file ${a.path}`);
    writeFileSync(p, a.replace_all ? text.split(a.old_text).join(a.new_text) : text.replace(a.old_text, () => a.new_text));
    return `Replaced ${a.replace_all ? count : 1} occurrence(s) in ${a.path}`;
  },
});

export const listDir = defineTool<{ path?: string; recursive?: boolean }>({
  name: 'list_dir',
  description: 'List files and folders in a directory (recursive=true lists all files, skipping node_modules/.git).',
  toolset: 'files',
  risk: 'safe',
  parameters: params({ path: str('Directory (default: workdir)'), recursive: bool('List recursively') }),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    if (a.recursive) return truncate([...walk(p, 2000)].map((f) => relative(p, f)).join('\n') || '(empty)');
    return readdirSync(p, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n') || '(empty)';
  },
});

export const searchFiles = defineTool<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number }>({
  name: 'search_files',
  description: 'Search file contents with a regular expression (like grep). Returns file:line: text.',
  toolset: 'files',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params(
    { pattern: str('Regular expression'), path: str('Directory'), glob: str('Only files matching this glob, e.g. **/*.ts'), ignore_case: bool('Case-insensitive'), max_results: num('Max matches (default 100)') },
    ['pattern'],
  ),
  async execute(a, ctx) {
    const root = resolvePath(ctx, a.path);
    const re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
    const g = a.glob ? globToRegExp(a.glob) : undefined;
    const out: string[] = [];
    const max = a.max_results ?? 100;
    for (const f of walk(root)) {
      const rel = relative(root, f);
      if (g && !g.test(rel)) continue;
      if (statSync(f).size > 2_000_000) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i]!)) out.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
      if (out.length >= max) break;
    }
    return out.join('\n') || 'No matches.';
  },
});

export const findFiles = defineTool<{ glob: string; path?: string }>({
  name: 'find_files',
  description: 'Find files by glob pattern, e.g. "**/*.md" or "src/*.ts".',
  toolset: 'files',
  risk: 'safe',
  parameters: params({ glob: str('Glob pattern'), path: str('Base directory') }, ['glob']),
  async execute(a, ctx) {
    const root = resolvePath(ctx, a.path);
    const re = globToRegExp(a.glob);
    const hits = [...walk(root)].map((f) => relative(root, f)).filter((f) => re.test(f) || re.test(f.split('/').pop()!));
    return truncate(hits.slice(0, 500).join('\n')) || 'No files found.';
  },
});

export const fileInfo = defineTool<{ path: string }>({
  name: 'file_info',
  description: 'Get size, type and modification time of a file or folder.',
  toolset: 'files',
  risk: 'safe',
  parameters: params({ path: str('Path') }, ['path']),
  async execute(a, ctx) {
    const st = statSync(resolvePath(ctx, a.path));
    return JSON.stringify({ type: st.isDirectory() ? 'directory' : 'file', size: st.size, modified: st.mtime.toISOString(), mode: (st.mode & 0o777).toString(8) });
  },
});

export const deleteFile = defineTool<{ path: string }>({
  name: 'delete_file',
  description: 'Delete a file (snapshotted, so it can be restored with /rollback). Folders are not deleted.',
  toolset: 'files',
  risk: 'dangerous',
  sensitive: true,
  needsApproval: (a) => `delete ${a.path}`,
  parameters: params({ path: str('File path') }, ['path']),
  async execute(a, ctx) {
    const p = resolvePath(ctx, a.path);
    if (statSync(p).isDirectory()) return { content: 'Refusing to delete a directory.', isError: true };
    snapshot(ctx, p, `delete_file ${a.path}`);
    rmSync(p);
    return `Deleted ${a.path}`;
  },
});

export const moveFile = defineTool<{ from: string; to: string }>({
  name: 'move_file',
  description: 'Move or rename a file.',
  toolset: 'files',
  risk: 'moderate',
  sensitive: true,
  parameters: params({ from: str('Source path'), to: str('Destination path') }, ['from', 'to']),
  async execute(a, ctx) {
    const from = resolvePath(ctx, a.from);
    const to = resolvePath(ctx, a.to);
    snapshot(ctx, from, `move_file ${a.from}`);
    snapshot(ctx, to, `move_file ${a.to}`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return `Moved ${a.from} → ${a.to}`;
  },
});

export const makeDir = defineTool<{ path: string }>({
  name: 'make_dir',
  description: 'Create a directory (including parents).',
  toolset: 'files',
  risk: 'safe',
  parameters: params({ path: str('Directory path') }, ['path']),
  async execute(a, ctx) {
    mkdirSync(resolvePath(ctx, a.path), { recursive: true });
    return `Created ${a.path}`;
  },
});

export const fileTools: AnyTool[] = [readFile, writeFile, editFile, listDir, searchFiles, findFiles, fileInfo, deleteFile, moveFile, makeDir];
