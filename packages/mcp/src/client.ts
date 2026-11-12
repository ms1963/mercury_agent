/**
 * MCP client manager: connects to external MCP servers (stdio, Streamable HTTP, SSE),
 * discovers their tools and registers them as Mercury tools named `mcp_<server>_<tool>`
 * (toolset `mcp:<server>`), honouring include/exclude filters. Optional sampling lets
 * a trusted server ask Mercury's LLM for completions. Output of untrusted servers is
 * spotlighted like any other external content.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  errorMessage,
  globMatch,
  SYSTEM_PRINCIPAL,
  type AnyTool,
  type JsonSchema,
  type LLMService,
  type Logger,
  type McpServerConfig,
  type ToolRegistry,
} from '@mercury/core';

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

interface Connection {
  client: Client;
  status: McpServerStatus;
}

/** Content blocks returned by MCP tools → plain text for the model. */
export function mcpContentToText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((c: { type?: string; text?: string; resource?: { text?: string; uri?: string }; mimeType?: string }) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      if (c.type === 'image' || c.type === 'audio') return `[${c.type} ${c.mimeType ?? ''}]`;
      return JSON.stringify(c);
    })
    .join('\n');
}

export const mcpToolName = (server: string, tool: string) => `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

export class McpClientManager {
  private conns = new Map<string, Connection>();

  constructor(private registry: ToolRegistry, private logger: Logger, private llm?: LLMService) {}

  private transportFor(cfg: McpServerConfig): Transport {
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error('stdio MCP server needs "command"');
      return new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...getDefaultEnvironment(), ...cfg.env }, stderr: 'pipe' });
    }
    if (!cfg.url) throw new Error(`${cfg.transport} MCP server needs "url"`);
    const init = { requestInit: { headers: cfg.headers } };
    return cfg.transport === 'sse' ? new SSEClientTransport(new URL(cfg.url), init) : new StreamableHTTPClientTransport(new URL(cfg.url), init);
  }

  /** Connect (or reconnect) one server and register its tools. */
  async connect(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    await this.disconnect(name);
    const status: McpServerStatus = { name, transport: cfg.transport, connected: false, tools: [] };
    const client = new Client({ name: 'mercury', version: '0.1.0' }, { capabilities: cfg.allowSampling ? { sampling: {} } : {} });
    if (cfg.allowSampling && this.llm) {
      const llm = this.llm;
      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        const messages = req.params.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: (m.content as { type: string; text?: string }).type === 'text' ? ((m.content as { text?: string }).text ?? '') : '[non-text content]',
        }));
        if (req.params.systemPrompt) messages.unshift({ role: 'user', content: `System: ${req.params.systemPrompt}` });
        const res = await llm.complete(SYSTEM_PRINCIPAL, messages, { maxTokens: req.params.maxTokens, kind: 'mcp-sampling' });
        return { model: res.modelId, role: 'assistant', content: { type: 'text', text: res.content } };
      });
    }
    try {
      await client.connect(this.transportFor(cfg));
      const { tools } = await client.listTools();
      for (const t of tools) {
        if (cfg.include.length && !cfg.include.some((p) => globMatch(p, t.name))) continue;
        if (cfg.exclude.some((p) => globMatch(p, t.name))) continue;
        const tool = this.wrapTool(name, cfg, client, t);
        this.registry.register(tool);
        status.tools.push(tool.name);
      }
      status.connected = true;
    } catch (err) {
      status.error = errorMessage(err);
      this.logger.warn(`MCP server "${name}" failed to connect`, { error: status.error });
      await client.close().catch(() => undefined);
    }
    this.conns.set(name, { client, status });
    return status;
  }

  private wrapTool(server: string, cfg: McpServerConfig, client: Client, t: { name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): AnyTool {
    const destructive = t.annotations?.destructiveHint === true;
    const readOnly = t.annotations?.readOnlyHint === true;
    return {
      name: mcpToolName(server, t.name),
      description: `[MCP ${server}] ${t.description ?? t.name}`,
      toolset: `mcp:${server}`,
      parameters: (t.inputSchema as JsonSchema) ?? { type: 'object', properties: {} },
      risk: destructive ? 'dangerous' : readOnly ? 'safe' : 'moderate',
      sensitive: !readOnly,
      untrustedOutput: cfg.trust !== 'trusted',
      source: `mcp:${server}`,
      async execute(args, ctx) {
        const res = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: ctx.signal });
        return { content: mcpContentToText(res.content), isError: res.isError === true, data: res.structuredContent };
      },
    };
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<McpServerStatus[]> {
    const entries = Object.entries(servers).filter(([, c]) => c.enabled);
    return Promise.all(entries.map(([n, c]) => this.connect(n, c)));
  }

  async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    this.registry.unregisterSource(`mcp:${name}`);
    this.conns.delete(name);
    await c.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => c.status);
  }

  /** Raw client access (resources/prompts) for a connected server. */
  client(name: string): Client | undefined {
    return this.conns.get(name)?.client;
  }
}
