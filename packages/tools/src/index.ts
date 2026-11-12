/**
 * @mercury/tools — built-in tool library, polyglot tool runner, terminal/browser
 * backends and the execute_code sandbox.
 */
import type { AnyTool, ToolRegistry } from '@mercury/core';
import { fileTools } from './builtin/files.js';
import { terminalTools } from './builtin/terminal.js';
import { webTools } from './builtin/web.js';
import { browserTools } from './builtin/browser.js';
import { codeTools } from './builtin/code.js';
import { utilityTools } from './builtin/utility.js';
import { dataTools } from './builtin/data.js';
import { memoryTools } from './builtin/memory.js';
import { agentTools } from './builtin/agents.js';
import { mediaTools } from './builtin/media.js';
import { decisionTools } from './builtin/decisions.js';

/** Every built-in tool, grouped by toolset via `tool.toolset`. */
export const BUILTIN_TOOLS: AnyTool[] = [
  ...fileTools,
  ...terminalTools,
  ...webTools,
  ...browserTools,
  ...codeTools,
  ...utilityTools,
  ...dataTools,
  ...memoryTools,
  ...agentTools,
  ...mediaTools,
  ...decisionTools,
];

export function registerBuiltinTools(registry: ToolRegistry): number {
  for (const tool of BUILTIN_TOOLS) registry.register({ ...tool, source: tool.source ?? 'builtin' });
  return BUILTIN_TOOLS.length;
}

export * from './util.js';
export * from './terminal/backends.js';
export * from './terminal/processes.js';
export * from './browser/backends.js';
export * from './sandbox/execute-code.js';
export * from './polyglot/runner.js';
export { walk, globToRegExp } from './builtin/files.js';
export { evaluate, convertUnit, lineDiff } from './builtin/utility.js';
export { jsonPath, parseCsv } from './builtin/data.js';
export { parseFeed, webSearch } from './builtin/web.js';
export { terminalOf, processesOf } from './builtin/terminal.js';
