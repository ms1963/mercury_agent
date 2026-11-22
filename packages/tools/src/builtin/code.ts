/** Code tools: execute_code sandbox (toolset "code") and git helpers (toolset "git"). */
import { defineTool, type AnyTool } from '@mercury/core';
import { executeCode } from '../sandbox/execute-code.js';
import { runArgv } from '../terminal/backends.js';
import { arr, bool, num, params, resolvePath, str, strEnum, truncate } from '../util.js';

export const executeCodeTool = defineTool<{ code: string; language?: 'python' | 'javascript' }>({
  name: 'execute_code',
  description:
    'Run a Python or JavaScript script that can call other tools programmatically: Python `call_tool("web_search", query="x")`, JS `await callTool("read_file", {path: "a.txt"})`. Use it to batch many tool calls or process data. Print results to stdout.',
  toolset: 'code',
  risk: 'moderate',
  sensitive: true,
  hostAccess: true,
  parameters: params({ code: str('Script source'), language: strEnum(['python', 'javascript'], 'Language (default python)') }, ['code']),
  async execute(a, ctx) {
    const r = await executeCode(ctx, a.language ?? 'python', a.code);
    const out = [`exit_code: ${r.exitCode ?? 'killed'}${r.timedOut ? ' (timed out)' : ''}, tool_calls: ${r.toolCalls}`];
    if (r.stdout) out.push(`stdout:\n${r.stdout}`);
    if (r.stderr) out.push(`stderr:\n${r.stderr}`);
    return { content: truncate(out.join('\n')), isError: r.exitCode !== 0 };
  },
});

async function git(args: string[], cwd: string): Promise<{ content: string; isError: boolean }> {
  const r = await runArgv(['git', ...args], { cwd, timeoutMs: 30_000 });
  return { content: truncate((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || '(no output)'), isError: r.exitCode !== 0 };
}

export const gitStatus = defineTool<{ path?: string }>({
  name: 'git_status',
  description: 'Show git status (branch and changed files) of a repository.',
  toolset: 'git',
  risk: 'safe',
  parameters: params({ path: str('Repository path') }),
  execute: (a, ctx) => git(['status', '--short', '--branch'], resolvePath(ctx, a.path)),
});

export const gitDiff = defineTool<{ path?: string; staged?: boolean; file?: string }>({
  name: 'git_diff',
  description: 'Show the git diff of uncommitted (or staged) changes.',
  toolset: 'git',
  risk: 'safe',
  parameters: params({ path: str('Repository path'), staged: bool('Staged changes only'), file: str('Limit to file') }),
  execute: (a, ctx) => git(['diff', ...(a.staged ? ['--staged'] : []), ...(a.file ? ['--', a.file] : [])], resolvePath(ctx, a.path)),
});

export const gitLog = defineTool<{ path?: string; limit?: number }>({
  name: 'git_log',
  description: 'Show recent commits.',
  toolset: 'git',
  risk: 'safe',
  parameters: params({ path: str('Repository path'), limit: num('Number of commits (default 10)') }),
  execute: (a, ctx) => git(['log', '--oneline', '--decorate', `-n${a.limit ?? 10}`], resolvePath(ctx, a.path)),
});

export const gitCommit = defineTool<{ path?: string; message: string; files?: string[] }>({
  name: 'git_commit',
  description: 'Stage files (default: all changes) and create a commit.',
  toolset: 'git',
  risk: 'moderate',
  sensitive: true,
  parameters: params({ path: str('Repository path'), message: str('Commit message'), files: arr(str('file'), 'Files to stage') }, ['message']),
  async execute(a, ctx) {
    const cwd = resolvePath(ctx, a.path);
    const add = await git(['add', ...(a.files?.length ? a.files : ['-A'])], cwd);
    if (add.isError) return add;
    return git(['-c', 'user.name=Mercury Agent', '-c', 'user.email=agent@mercury.local', 'commit', '-m', a.message], cwd);
  },
});

export const codeTools: AnyTool[] = [executeCodeTool, gitStatus, gitDiff, gitLog, gitCommit];
