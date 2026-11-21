/**
 * Curated MCP connector presets.
 *
 * Each preset is a ready-to-use {@link McpServerConfig} for a well-known MCP server, with a safe
 * default policy (untrusted trust so its output is spotlighted, sampling off) and — crucially —
 * NO hardcoded secrets: anything sensitive (tokens, paths, DB files) is a `${ENV_VAR}` placeholder
 * documented in `requiredEnv`. The user discovers presets with `mercury mcp presets` and enables
 * one with `mercury mcp enable <preset>`, which substitutes the placeholders from the environment
 * and writes the resulting server config into `mcp.servers.<name>` (then the existing MCP subsystem
 * connects to it exactly like any user-defined server).
 */
import type { McpServerConfig } from '@mercury/core';

/** A curated MCP server preset: a safe default config plus the env vars it needs. */
export interface McpPreset {
  /** Stable preset id (also the default server name under mcp.servers). */
  name: string;
  /** One-line description shown by `mercury mcp presets`. */
  description: string;
  /** Environment variables the user must set before enabling (placeholders, never secrets). */
  requiredEnv: string[];
  /** Short note on what the server can do and why its default trust is `untrusted`. */
  notes: string;
  /** The server config, with `${ENV_VAR}` placeholders left unresolved. */
  config: McpServerConfig;
}

/** Fill in the McpServerConfig defaults so a preset is a complete, valid config object. */
function server(partial: Partial<McpServerConfig>): McpServerConfig {
  return {
    transport: 'stdio',
    command: undefined,
    args: [],
    env: {},
    url: undefined,
    headers: {},
    include: [],
    exclude: [],
    trust: 'untrusted',
    allowSampling: false,
    enabled: true,
    ...partial,
  } as McpServerConfig;
}

/**
 * The curated presets. These reference the official reference servers published by the MCP
 * project; the user is expected to have the relevant runner (npx / uvx) available. All default to
 * `trust: 'untrusted'` so their output is treated as untrusted content by Mercury's taint tracker.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    name: 'filesystem',
    description: 'Read/write files under a sandboxed root directory',
    requiredEnv: ['MCP_FS_ROOT'],
    notes: 'Exposes file operations limited to MCP_FS_ROOT. Keep it untrusted: file contents are external input.',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'] }),
  },
  {
    name: 'fetch',
    description: 'HTTP fetch + HTML-to-markdown for web content',
    requiredEnv: [],
    notes: 'Fetches arbitrary URLs. Output is untrusted web content (prompt-injection risk) — leave trust=untrusted.',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
  },
  {
    name: 'github',
    description: 'GitHub repos, issues and pull requests via the GitHub MCP server',
    requiredEnv: ['GITHUB_TOKEN'],
    notes: 'Needs a personal access token (GITHUB_TOKEN). Issue/PR text is external input — keep untrusted.',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } }),
  },
  {
    name: 'git',
    description: 'Local git repository operations (status, log, diff, commit)',
    requiredEnv: ['MCP_GIT_REPO'],
    notes: 'Operates on the repository at MCP_GIT_REPO. Commit/diff content is external input — keep untrusted.',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '${MCP_GIT_REPO}'] }),
  },
  {
    name: 'sqlite',
    description: 'Query and inspect a local SQLite database',
    requiredEnv: ['MCP_SQLITE_DB'],
    notes: 'Opens the database file at MCP_SQLITE_DB. Row data is external input — keep untrusted.',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '${MCP_SQLITE_DB}'] }),
  },
];

/** Look up a preset by name. */
export function mcpPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.name === name);
}

/** List all curated presets. */
export function mcpPresets(): McpPreset[] {
  return MCP_PRESETS;
}

const PLACEHOLDER = /\$\{(\w+)\}/g;

function substitute(value: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return value.replace(PLACEHOLDER, (_m, key: string) => {
    const v = env[key];
    if (v === undefined || v === '') {
      missing.add(key);
      return `\${${key}}`;
    }
    return v;
  });
}

export interface ResolvedPreset {
  name: string;
  config: McpServerConfig;
  /** Required env vars that were not set (the config still contains their placeholders). */
  missingEnv: string[];
}

/**
 * Resolve a preset's `${ENV_VAR}` placeholders from `env` (defaults to process.env), returning the
 * concrete {@link McpServerConfig} to store under mcp.servers plus any still-missing env vars. No
 * secret value is ever stored in the preset itself — only the resolved config the user writes.
 */
export function resolvePreset(preset: McpPreset, env: Record<string, string | undefined> = process.env): ResolvedPreset {
  const missing = new Set<string>();
  const cfg = preset.config;
  const resolved: McpServerConfig = {
    ...cfg,
    command: cfg.command ? substitute(cfg.command, env, missing) : cfg.command,
    url: cfg.url ? substitute(cfg.url, env, missing) : cfg.url,
    args: cfg.args.map((a) => substitute(a, env, missing)),
    env: Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, substitute(v, env, missing)])),
    headers: Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, substitute(v, env, missing)])),
  };
  for (const key of preset.requiredEnv) if (env[key] === undefined || env[key] === '') missing.add(key);
  return { name: preset.name, config: resolved, missingEnv: [...missing] };
}
