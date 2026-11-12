/**
 * Terminal & process tools (toolsets "terminal" and "process"). Commands are risk-
 * assessed; moderate/dangerous commands require approval (per approvals.mode).
 */
import { assessCommand, defineTool, type AnyTool, type ToolContext } from '@mercury/core';
import { createTerminalBackend, type TerminalBackend } from '../terminal/backends.js';
import { ProcessManager } from '../terminal/processes.js';
import { num, params, resolvePath, str, strEnum, truncate } from '../util.js';

/** Backend and process manager live in `services.extra` so the runtime can swap them. */
export function terminalOf(ctx: ToolContext): TerminalBackend {
  const extra = ctx.services.extra;
  if (!extra.terminal) extra.terminal = createTerminalBackend(ctx.services.config);
  return extra.terminal as TerminalBackend;
}

export function processesOf(ctx: ToolContext): ProcessManager {
  const extra = ctx.services.extra;
  if (!extra.processes) extra.processes = new ProcessManager();
  return extra.processes as ProcessManager;
}

const commandApproval = (a: { command: string }) => {
  const risk = assessCommand(a.command);
  return risk.level === 'safe' ? undefined : `${risk.level} command: ${risk.reasons.join(', ')}`;
};

export const terminal = defineTool<{ command: string; cwd?: string; timeout_s?: number }>({
  name: 'terminal',
  description: 'Run a shell command and return stdout/stderr/exit code. Use process_start for long-running servers.',
  toolset: 'terminal',
  risk: 'moderate',
  sensitive: true,
  needsApproval: commandApproval,
  parameters: params({ command: str('Shell command'), cwd: str('Working directory'), timeout_s: num('Timeout in seconds') }, ['command']),
  async execute(a, ctx) {
    const cwd = resolvePath(ctx, a.cwd);
    const timeoutMs = Math.min((a.timeout_s ?? ctx.services.config.tools.terminal.timeoutMs / 1000) * 1000, 600_000);
    const r = await terminalOf(ctx).run(a.command, { cwd, timeoutMs, signal: ctx.signal });
    const parts = [`exit_code: ${r.exitCode ?? 'killed'}${r.timedOut ? ' (timed out)' : ''}`];
    if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
    if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
    return { content: truncate(parts.join('\n')), isError: r.exitCode !== 0, data: { exitCode: r.exitCode } };
  },
});

export const processStart = defineTool<{ command: string; cwd?: string }>({
  name: 'process_start',
  description: 'Start a long-running background command (e.g. a dev server). Returns a process id.',
  toolset: 'process',
  risk: 'moderate',
  sensitive: true,
  needsApproval: commandApproval,
  parameters: params({ command: str('Shell command'), cwd: str('Working directory') }, ['command']),
  async execute(a, ctx) {
    const cwd = resolvePath(ctx, a.cwd);
    const p = processesOf(ctx).start(ctx.principal.userId, terminalOf(ctx).argv(a.command, { cwd }), cwd, a.command);
    return `Started process ${p.id}. Use process_output to read its output.`;
  },
});

export const processList = defineTool<Record<string, never>>({
  name: 'process_list',
  description: 'List background processes started by you.',
  toolset: 'process',
  risk: 'safe',
  parameters: params({}),
  async execute(_a, ctx) {
    const list = processesOf(ctx).list(ctx.principal.userId);
    return list.map((p) => `${p.id}  ${p.running ? 'running' : `exited(${p.exitCode})`}  ${p.command}`).join('\n') || 'No processes.';
  },
});

export const processOutput = defineTool<{ id: string; tail?: number }>({
  name: 'process_output',
  description: 'Read the latest output of a background process.',
  toolset: 'process',
  risk: 'safe',
  untrustedOutput: true,
  parameters: params({ id: str('Process id'), tail: num('Characters from the end (default 4000)') }, ['id']),
  async execute(a, ctx) {
    const p = processesOf(ctx).get(a.id, ctx.principal.userId);
    if (!p) return { content: `No process ${a.id}`, isError: true };
    return `[${p.running ? 'running' : `exited ${p.exitCode}`}]\n${p.output.slice(-(a.tail ?? 4000))}`;
  },
});

export const processKill = defineTool<{ id: string; signal?: string }>({
  name: 'process_kill',
  description: 'Stop a background process.',
  toolset: 'process',
  risk: 'moderate',
  parameters: params({ id: str('Process id'), signal: strEnum(['TERM'], 'Signal') }, ['id']),
  async execute(a, ctx) {
    return processesOf(ctx).kill(a.id, ctx.principal.userId) ? `Stopping ${a.id}` : { content: `No process ${a.id}`, isError: true };
  },
});

export const terminalTools: AnyTool[] = [terminal, processStart, processList, processOutput, processKill];
