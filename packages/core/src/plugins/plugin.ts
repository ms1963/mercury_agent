/**
 * Plugin architecture. A plugin is an ES module exporting `default` (or `plugin`)
 * implementing `Plugin`. In `setup(api)` it can register tools, hooks, memory
 * providers, context engines, LLM/decision providers, patterns, workflow templates
 * and gateway adapters.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../logging/logger.js';
import type { HookHandler, HookName } from './hooks.js';
import type { AnyTool } from '../tools/types.js';
import type { MemoryProvider, ContextEngine } from '../memory/providers.js';
import type { LLMProvider } from '../llm/provider.js';
import type { DecisionProvider } from '../decision/types.js';
import type { Pattern } from '../agent/patterns/types.js';
import type { WorkflowTemplate } from '../workflows/types.js';
import type { MercuryConfig } from '../config/schema.js';
import { errorMessage } from '../types/common.js';

export interface PluginAPI {
  config: MercuryConfig;
  logger: Logger;
  registerTool(tool: AnyTool): void;
  registerHook(hook: HookName, handler: HookHandler, priority?: number): void;
  registerMemoryProvider(provider: MemoryProvider): void;
  registerContextEngine(engine: ContextEngine): void;
  registerLLMProvider(provider: LLMProvider): void;
  registerDecisionProvider(provider: DecisionProvider): void;
  registerPattern(pattern: Pattern): void;
  registerWorkflowTemplate(template: WorkflowTemplate): void;
  /** Adapter factories are typed loosely here to keep core independent of the gateway package. */
  registerAdapter(type: string, factory: (config: Record<string, unknown>) => unknown): void;
}

export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  setup(api: PluginAPI): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  path: string;
  error?: string;
}

/** Find plugin entry points: `<dir>/<name>.js|.mjs` or `<dir>/<name>/index.js`. */
export function discoverPlugins(dirs: string[], explicit: string[] = []): string[] {
  const found: string[] = explicit.map((p) => resolve(p));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (/\.(m?js)$/.test(entry)) found.push(full);
      else if (statSync(full).isDirectory()) {
        const idx = ['index.js', 'index.mjs', 'dist/index.js'].map((f) => join(full, f)).find(existsSync);
        if (idx) found.push(idx);
      }
    }
  }
  return [...new Set(found)];
}

export async function loadPlugin(path: string, api: PluginAPI): Promise<{ plugin?: Plugin; info: LoadedPlugin }> {
  try {
    const mod = (await import(pathToFileURL(path).href)) as { default?: Plugin; plugin?: Plugin };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin || typeof plugin.setup !== 'function') throw new Error('module does not export a Plugin (default export with setup())');
    await plugin.setup(api);
    return { plugin, info: { name: plugin.name, version: plugin.version, description: plugin.description, path } };
  } catch (err) {
    api.logger.warn(`plugin failed to load: ${path}`, { error: errorMessage(err) });
    return { info: { name: path.split('/').slice(-2).join('/'), path, error: errorMessage(err) } };
  }
}
