/**
 * Wiring tests for the v1.8.0 optional MCP integrations (Google Calendar, CalDAV, Slack,
 * Playwright, Puppeteer, Brave Search, Tavily, Redis, PostgreSQL, Discord, Microsoft Teams,
 * Notion, Confluence, Obsidian).
 *
 * SCOPE: these tests verify the WIRING only — that every preset is registered, disabled by
 * default, round-trips its enabled flag through ConfigSchema, that connectAll skips disabled
 * servers, that tool names are namespaced, and that each preset declares its required env vars.
 *
 * They deliberately do NOT open any real socket to Slack / Postgres / Redis / etc. Live
 * connectivity needs real credentials and a reachable server and is OUT OF CI SCOPE — it is
 * exercised manually by the operator after setting the documented env vars in ~/.mercury/.env.
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema, ToolRegistry, silentLogger, type McpServerConfig } from '@mercury/core';
import {
  INTEGRATION_PRESETS,
  McpClientManager,
  enablePresetConfig,
  mcpPreset,
  mcpPresets,
  mcpToolName,
} from '@mercury/mcp';

const INTEGRATIONS = [
  'google-calendar', 'caldav', 'slack', 'playwright', 'puppeteer', 'brave-search', 'tavily',
  'redis', 'postgres', 'discord', 'teams', 'notion', 'confluence', 'obsidian',
];

describe('v1.8.0 MCP integration presets — catalog', () => {
  it('registers all 14 optional integrations in the preset catalog', () => {
    const names = mcpPresets().map((p) => p.name);
    for (const n of INTEGRATIONS) expect(names, `preset "${n}" missing`).toContain(n);
    expect(INTEGRATION_PRESETS.slice().sort()).toEqual(INTEGRATIONS.slice().sort());
  });

  it('keeps the original 5 core presets too', () => {
    const names = mcpPresets().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['filesystem', 'fetch', 'github', 'git', 'sqlite']));
  });

  it('declares provenance and a concrete (non-placeholder) package for every integration', () => {
    for (const n of INTEGRATIONS) {
      const p = mcpPreset(n)!;
      expect(p, n).toBeDefined();
      expect(['official', 'official-archived', 'community']).toContain(p.provenance);
      expect(p.pkg, `${n} package`).toBeTruthy();
      // No fabricated/placeholder package names were allowed into the catalog.
      expect(p.pkg.toLowerCase()).not.toMatch(/community-or-custom|placeholder|todo|<|>/);
    }
  });

  it('declares the required env vars for each integration that needs secrets', () => {
    const expectEnv: Record<string, string[]> = {
      'google-calendar': ['GOOGLE_OAUTH_CREDENTIALS'],
      caldav: ['CALDAV_BASE_URL', 'CALDAV_USERNAME', 'CALDAV_PASSWORD'],
      slack: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
      playwright: [],
      puppeteer: [],
      'brave-search': ['BRAVE_API_KEY'],
      tavily: ['TAVILY_API_KEY'],
      redis: ['REDIS_URL'],
      postgres: ['POSTGRES_URL'],
      discord: ['DISCORD_TOKEN'],
      teams: ['TEAMS_MCP_CLIENT_ID', 'TEAMS_MCP_TENANT_ID'],
      notion: ['NOTION_TOKEN'],
      confluence: ['ATLASSIAN_SITE_NAME', 'ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN'],
      obsidian: ['OBSIDIAN_VAULT_PATH'],
    };
    for (const [name, env] of Object.entries(expectEnv)) {
      expect(mcpPreset(name)!.requiredEnv.slice().sort(), name).toEqual(env.slice().sort());
    }
  });

  it('never hardcodes a secret value in any preset', () => {
    const blob = JSON.stringify(mcpPresets());
    expect(blob).not.toMatch(/ghp_|xoxb-|sk-[a-z0-9]|secret[0-9]/i);
    // Every secret surface is a ${ENV} placeholder, not a literal.
    for (const n of INTEGRATIONS) {
      const p = mcpPreset(n)!;
      for (const v of Object.values(p.config.env)) expect(v).toMatch(/^\$\{[A-Z0-9_]+\}$/);
    }
  });
});

describe('v1.8.0 MCP integration presets — disabled by default', () => {
  it('every preset is disabled in the catalog (templates, never auto-on)', () => {
    for (const p of mcpPresets()) expect(p.config.enabled, `${p.name} should be disabled by default`).toBe(false);
  });
});

describe('v1.8.0 MCP integration presets — enable/disable round-trips through ConfigSchema', () => {
  it('enabling a preset produces an enabled, schema-valid server entry', () => {
    const resolved = enablePresetConfig(mcpPreset('slack')!, { SLACK_BOT_TOKEN: 'x', SLACK_TEAM_ID: 'T1' });
    expect(resolved.config.enabled).toBe(true);
    expect(resolved.missingEnv).toHaveLength(0);
    const parsed = ConfigSchema.parse({ mcp: { servers: { slack: resolved.config } } });
    expect(parsed.mcp.servers.slack.enabled).toBe(true);
    expect(parsed.mcp.servers.slack.env.SLACK_BOT_TOKEN).toBe('x');
  });

  it('reports missing env vars and leaves placeholders in the written config', () => {
    const resolved = enablePresetConfig(mcpPreset('postgres')!, {});
    expect(resolved.missingEnv).toContain('POSTGRES_URL');
    expect(resolved.config.args.join(' ')).toContain('${POSTGRES_URL}');
    // Still schema-valid even with placeholders present (so the user can fill env later).
    expect(() => ConfigSchema.parse({ mcp: { servers: { postgres: resolved.config } } })).not.toThrow();
  });

  it('disabling flips enabled to false and stays schema-valid', () => {
    const enabled = enablePresetConfig(mcpPreset('notion')!, { NOTION_TOKEN: 't' }).config;
    const disabled = { ...enabled, enabled: false };
    const parsed = ConfigSchema.parse({ mcp: { servers: { notion: disabled } } });
    expect(parsed.mcp.servers.notion.enabled).toBe(false);
  });
});

describe('v1.8.0 MCP integration presets — connectAll skips disabled servers', () => {
  // Recording subclass: overrides connect() so NO real network/stdio transport is ever opened.
  class RecordingManager extends McpClientManager {
    public attempted: string[] = [];
    async connect(name: string, cfg: McpServerConfig) {
      this.attempted.push(name);
      return { name, transport: cfg.transport, connected: true, tools: [] };
    }
  }

  const srv = (enabled: boolean): McpServerConfig =>
    ConfigSchema.parse({ mcp: { servers: { x: { transport: 'stdio', command: 'noop', enabled } } } }).mcp.servers.x;

  it('connects only the enabled servers', async () => {
    const mgr = new RecordingManager(new ToolRegistry(ConfigSchema.parse({})), silentLogger);
    await mgr.connectAll({ on1: srv(true), off1: srv(false), on2: srv(true), off2: srv(false) });
    expect(mgr.attempted.sort()).toEqual(['on1', 'on2']);
  });

  it('connects nothing when all servers are disabled (default preset state)', async () => {
    const mgr = new RecordingManager(new ToolRegistry(ConfigSchema.parse({})), silentLogger);
    const servers: Record<string, McpServerConfig> = {};
    for (const n of INTEGRATIONS) {
      servers[n] = { ...enablePresetConfig(mcpPreset(n)!, {}).config, enabled: false };
    }
    await mgr.connectAll(servers);
    expect(mgr.attempted).toHaveLength(0);
  });
});

describe('v1.8.0 MCP integration presets — tool namespacing', () => {
  it('namespaces tools per server as mcp_<server>_<tool>', () => {
    expect(mcpToolName('slack', 'post_message')).toBe('mcp_slack_post_message');
    expect(mcpToolName('postgres', 'query')).toBe('mcp_postgres_query');
    // Hyphenated server names (brave-search, google-calendar) are sanitised to valid tool-name chars.
    expect(mcpToolName('brave-search', 'web')).toBe('mcp_brave-search_web');
    expect(mcpToolName('x', 'a:b/c')).toMatch(/^mcp_x_a_b_c$/);
    expect(mcpToolName('x', 'y').length).toBeLessThanOrEqual(64);
  });
});
