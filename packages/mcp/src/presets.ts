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

/**
 * Provenance of the underlying MCP server package, recorded honestly so the user knows what they
 * are running:
 *  - `official`          — a currently-maintained first-party server (MCP reference servers that are
 *                          still active, or a vendor's own server, e.g. @playwright/mcp, Notion, Tavily).
 *  - `official-archived` — a first-party reference server that still publishes to npm but now lives in
 *                          the MCP `servers-archived` repo (e.g. server-slack, server-postgres). It
 *                          works, but is no longer actively maintained upstream.
 *  - `community`         — a well-known third-party/community server. Verified to exist on npm, but not
 *                          vendor-official; review it before trusting it with credentials.
 *
 * Every preset shipped here has been verified to resolve on npm (`npm view <pkg> version`). None is a
 * fabricated or placeholder package name.
 */
export type McpProvenance = 'official' | 'official-archived' | 'community';

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
  /** Honest provenance of the backing package (official / archived reference / community). */
  provenance: McpProvenance;
  /** The npm package (or runner target) the preset invokes — for docs and `mcp presets`. */
  pkg: string;
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
    // Presets are templates: a preset is DISABLED by default and only becomes active when the user
    // explicitly runs `mercury mcp enable <preset>` (which writes the config with enabled: true) or
    // toggles it on in the web UI. connectAll() skips every server whose `enabled` is false.
    enabled: false,
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
    provenance: 'official',
    pkg: '@modelcontextprotocol/server-filesystem',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'] }),
  },
  {
    name: 'fetch',
    description: 'HTTP fetch + HTML-to-markdown for web content',
    requiredEnv: [],
    notes: 'Fetches arbitrary URLs. Output is untrusted web content (prompt-injection risk) — leave trust=untrusted.',
    provenance: 'official',
    pkg: 'mcp-server-fetch (uvx)',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
  },
  {
    name: 'github',
    description: 'GitHub repos, issues and pull requests via the GitHub MCP server',
    requiredEnv: ['GITHUB_TOKEN'],
    notes: 'Needs a personal access token (GITHUB_TOKEN). Issue/PR text is external input — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-github',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } }),
  },
  {
    name: 'git',
    description: 'Local git repository operations (status, log, diff, commit)',
    requiredEnv: ['MCP_GIT_REPO'],
    notes: 'Operates on the repository at MCP_GIT_REPO. Commit/diff content is external input — keep untrusted.',
    provenance: 'official',
    pkg: 'mcp-server-git (uvx)',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '${MCP_GIT_REPO}'] }),
  },
  {
    name: 'sqlite',
    description: 'Query and inspect a local SQLite database',
    requiredEnv: ['MCP_SQLITE_DB'],
    notes: 'Opens the database file at MCP_SQLITE_DB. Row data is external input — keep untrusted.',
    provenance: 'official-archived',
    pkg: 'mcp-server-sqlite (uvx)',
    config: server({ transport: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '${MCP_SQLITE_DB}'] }),
  },

  // ---------------------------------------------------------------------------
  // v1.8.0 optional integrations — all OFF by default; enable explicitly.
  // Package names below were each verified with `npm view <pkg> version`.
  // ---------------------------------------------------------------------------
  {
    name: 'google-calendar',
    description: 'Google Calendar: list/create/update events across calendars',
    requiredEnv: ['GOOGLE_OAUTH_CREDENTIALS'],
    notes: 'OAuth client credentials JSON path in GOOGLE_OAUTH_CREDENTIALS. Event text is external input — keep untrusted.',
    provenance: 'community',
    pkg: '@cocal/google-calendar-mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'], env: { GOOGLE_OAUTH_CREDENTIALS: '${GOOGLE_OAUTH_CREDENTIALS}' } }),
  },
  {
    name: 'caldav',
    description: 'CalDAV calendars (Nextcloud, Fastmail, iCloud, Radicale, …)',
    requiredEnv: ['CALDAV_BASE_URL', 'CALDAV_USERNAME', 'CALDAV_PASSWORD'],
    notes: 'Connects to any CalDAV server. Credentials via env. Calendar/event text is external input — keep untrusted.',
    provenance: 'community',
    pkg: 'caldav-mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', 'caldav-mcp'], env: { CALDAV_BASE_URL: '${CALDAV_BASE_URL}', CALDAV_USERNAME: '${CALDAV_USERNAME}', CALDAV_PASSWORD: '${CALDAV_PASSWORD}' } }),
  },
  {
    name: 'slack',
    description: 'Slack: list channels, read history, post messages',
    requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    notes: 'Bot token + team id via env. Message content is external input — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-slack',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}', SLACK_TEAM_ID: '${SLACK_TEAM_ID}' } }),
  },
  {
    name: 'playwright',
    description: 'Browser automation & scraping via Playwright (Microsoft)',
    requiredEnv: [],
    notes: 'Drives a real browser. Page content is untrusted web input (prompt-injection risk) — keep untrusted.',
    provenance: 'official',
    pkg: '@playwright/mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }),
  },
  {
    name: 'puppeteer',
    description: 'Headless-Chrome browser automation via Puppeteer',
    requiredEnv: [],
    notes: 'Drives headless Chrome. Page content is untrusted web input (prompt-injection risk) — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-puppeteer',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] }),
  },
  {
    name: 'brave-search',
    description: 'Web & local search via the Brave Search API',
    requiredEnv: ['BRAVE_API_KEY'],
    notes: 'Needs a Brave Search API key. Search results are untrusted web content — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-brave-search',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } }),
  },
  {
    name: 'tavily',
    description: 'AI-optimised web search & extraction via Tavily',
    requiredEnv: ['TAVILY_API_KEY'],
    notes: 'Needs a Tavily API key. Search/extract output is untrusted web content — keep untrusted.',
    provenance: 'official',
    pkg: 'tavily-mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp'], env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' } }),
  },
  {
    name: 'redis',
    description: 'Redis: get/set keys and inspect data structures',
    requiredEnv: ['REDIS_URL'],
    notes: 'Connects to the Redis URL (redis://host:port). Stored values are external input — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-redis',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis', '${REDIS_URL}'] }),
  },
  {
    name: 'postgres',
    description: 'PostgreSQL: read-only SQL queries and schema inspection',
    requiredEnv: ['POSTGRES_URL'],
    notes: 'Connects to the POSTGRES_URL connection string. Row data is external input — keep untrusted.',
    provenance: 'official-archived',
    pkg: '@modelcontextprotocol/server-postgres',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${POSTGRES_URL}'] }),
  },
  {
    name: 'discord',
    description: 'Discord: read channels and send messages via a bot',
    requiredEnv: ['DISCORD_TOKEN'],
    notes: 'Needs a Discord bot token. Message content is external input — keep untrusted.',
    provenance: 'community',
    pkg: 'mcp-discord',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', 'mcp-discord'], env: { DISCORD_TOKEN: '${DISCORD_TOKEN}' } }),
  },
  {
    name: 'teams',
    description: 'Microsoft Teams via Microsoft Graph (chats, channels, messages)',
    requiredEnv: ['TEAMS_MCP_CLIENT_ID', 'TEAMS_MCP_TENANT_ID'],
    notes: 'Microsoft Graph app registration (client + tenant id) via env; an interactive auth step is required once. Message content is external input — keep untrusted.',
    provenance: 'community',
    pkg: '@floriscornel/teams-mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@floriscornel/teams-mcp@latest'], env: { TEAMS_MCP_CLIENT_ID: '${TEAMS_MCP_CLIENT_ID}', TEAMS_MCP_TENANT_ID: '${TEAMS_MCP_TENANT_ID}' } }),
  },
  {
    name: 'notion',
    description: 'Notion: search, read and update pages and databases',
    requiredEnv: ['NOTION_TOKEN'],
    notes: 'Needs a Notion integration token. Page content is external input — keep untrusted.',
    provenance: 'official',
    pkg: '@notionhq/notion-mcp-server',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: '${NOTION_TOKEN}' } }),
  },
  {
    name: 'confluence',
    description: 'Atlassian Confluence: list/get spaces & pages, search via CQL',
    requiredEnv: ['ATLASSIAN_SITE_NAME', 'ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN'],
    notes: 'Atlassian site name + user email + API token via env. Page content is external input — keep untrusted.',
    provenance: 'community',
    pkg: '@aashari/mcp-server-atlassian-confluence',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', '@aashari/mcp-server-atlassian-confluence'], env: { ATLASSIAN_SITE_NAME: '${ATLASSIAN_SITE_NAME}', ATLASSIAN_USER_EMAIL: '${ATLASSIAN_USER_EMAIL}', ATLASSIAN_API_TOKEN: '${ATLASSIAN_API_TOKEN}' } }),
  },
  {
    name: 'obsidian',
    description: 'Obsidian: read and edit notes in a local vault',
    requiredEnv: ['OBSIDIAN_VAULT_PATH'],
    notes: 'Operates on the vault at OBSIDIAN_VAULT_PATH (as vault "notes"). Note content is external input — keep untrusted.',
    provenance: 'community',
    pkg: 'obsidian-mcp',
    config: server({ transport: 'stdio', command: 'npx', args: ['-y', 'obsidian-mcp@2', 'serve', '--vault', 'notes=${OBSIDIAN_VAULT_PATH}'] }),
  },
];

/** Names of the 14 optional integration presets added in v1.8.0 (excludes the original 5 core presets). */
export const INTEGRATION_PRESETS = [
  'google-calendar', 'caldav', 'slack', 'playwright', 'puppeteer', 'brave-search', 'tavily',
  'redis', 'postgres', 'discord', 'teams', 'notion', 'confluence', 'obsidian',
] as const;

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

/**
 * Resolve a preset and mark it ENABLED — the exact {@link McpServerConfig} that `mercury mcp enable`
 * and the web UI write under `mcp.servers.<name>`. Presets are disabled templates; enabling is always
 * an explicit user action, so this is the single place that flips `enabled` to true.
 */
export function enablePresetConfig(preset: McpPreset, env: Record<string, string | undefined> = process.env): ResolvedPreset {
  const resolved = resolvePreset(preset, env);
  return { ...resolved, config: { ...resolved.config, enabled: true } };
}
