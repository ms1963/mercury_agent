/**
 * Tool registry with toolsets. Toolsets can be enabled/disabled globally
 * (`tools.toolsets`) and per platform (`tools.platforms.<platform>.disabledToolsets`).
 */
import type { MercuryConfig } from '../config/schema.js';
import type { ToolSpec } from '../types/messages.js';
import type { AnyTool } from './types.js';

export interface ToolsetInfo {
  name: string;
  tools: string[];
  enabled: boolean;
}

/** Toolsets disabled unless explicitly enabled (they need setup or are risky). */
const DEFAULT_OFF = new Set<string>([]);

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();
  private listeners = new Set<() => void>();

  constructor(private config: MercuryConfig) {}

  register(tool: AnyTool): void {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.changed();
  }

  unregister(name: string): void {
    if (this.tools.delete(name)) this.changed();
  }

  /** Remove all tools whose source matches (used by MCP hot reload / plugin unload). */
  unregisterSource(source: string): void {
    for (const [n, t] of this.tools) if (t.source === source) this.tools.delete(n);
    this.changed();
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()].sort((a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  toolsetEnabled(toolset: string, platform?: string): boolean {
    const explicit = this.config.tools.toolsets[toolset];
    if (explicit === false) return false;
    if (explicit === undefined && DEFAULT_OFF.has(toolset)) return false;
    if (platform && this.config.tools.platforms[platform]?.disabledToolsets.includes(toolset)) return false;
    return true;
  }

  setToolsetEnabled(toolset: string, enabled: boolean): void {
    this.config.tools.toolsets[toolset] = enabled;
    this.changed();
  }

  setToolEnabled(name: string, enabled: boolean): void {
    const d = new Set(this.config.tools.disabled);
    if (enabled) d.delete(name);
    else d.add(name);
    this.config.tools.disabled = [...d];
    this.changed();
  }

  isEnabled(tool: AnyTool, platform?: string, allowedToolsets?: string[]): boolean {
    if (this.config.tools.disabled.includes(tool.name)) return false;
    if (allowedToolsets && !allowedToolsets.includes(tool.toolset) && !allowedToolsets.includes(tool.name)) return false;
    return this.toolsetEnabled(tool.toolset, platform);
  }

  toolsets(platform?: string): ToolsetInfo[] {
    const map = new Map<string, string[]>();
    for (const t of this.list()) map.set(t.toolset, [...(map.get(t.toolset) ?? []), t.name]);
    return [...map.entries()].map(([name, tools]) => ({ name, tools, enabled: this.toolsetEnabled(name, platform) }));
  }

  /** Specs for the LLM, filtered by platform, allowed toolsets and an optional predicate. */
  specs(platform?: string, allowedToolsets?: string[], filter: (t: AnyTool) => boolean = () => true): ToolSpec[] {
    return this.list()
      .filter((t) => this.isEnabled(t, platform, allowedToolsets) && filter(t))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
}
