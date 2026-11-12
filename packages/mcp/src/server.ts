/**
 * Mercury as an MCP server. External, authorized apps (Claude Desktop, IDEs, other
 * agents) can control Mercury over stdio or Streamable HTTP (`/mcp`, Bearer API token).
 *
 * Exposed:
 *  - tools:     run_agent, run_workflow, list_workflows, memory_search, memory_add,
 *               skills_list, skill_get, schedule_list, schedule_create, plus every
 *               enabled Mercury tool (prefixed `mercury_`) when the token has the "tools" scope
 *  - resources: skill://<name>, memory://MEMORY.md, memory://USER.md
 *  - prompts:   one prompt per skill
 * Every call is checked against the token's scopes (mcp + the specific scope).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { errorMessage, type JsonSchema, type Principal, type ToolSpec } from '@mercury/core';

/** What the MCP server needs from Mercury. Implemented by the runtime. */
export interface McpBackend {
  toolSpecs(principal: Principal): ToolSpec[];
  callTool(principal: Principal, name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
  runAgent(principal: Principal, input: string, opts: { sessionId?: string; pattern?: string; model?: string }): Promise<{ output: string; sessionId: string; runId: string; status: string }>;
  runWorkflow(principal: Principal, workflow: string, input: string): Promise<{ output: string; runId: string }>;
  listWorkflows(): Array<{ name: string; type: string; description?: string }>;
  memorySearch(principal: Principal, query: string, k?: number): Promise<Array<{ id: string; content: string }>>;
  memoryAdd(principal: Principal, content: string): Promise<string>;
  readCurated(principal: Principal, which: 'memory' | 'user'): string;
  skills(): Array<{ name: string; description: string }>;
  skillBody(name: string): string;
  scheduleList(principal: Principal): Array<Record<string, unknown>>;
  scheduleCreate(principal: Principal, when: string, task: string): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function hasScope(p: Principal, scope: string): boolean {
  return p.scopes.includes('*') || p.scopes.includes(scope) || (scope !== 'admin' && p.scopes.includes('admin'));
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []) => ({ type: 'object' as const, properties, required });

interface MetaTool {
  name: string;
  description: string;
  scope: string;
  inputSchema: ReturnType<typeof obj>;
  run(b: McpBackend, p: Principal, a: Record<string, unknown>): Promise<string>;
}

const s = (description: string): JsonSchema => ({ type: 'string', description });

const META_TOOLS: MetaTool[] = [
  {
    name: 'run_agent',
    description: 'Run the Mercury agent on a task (full tool loop, memory, skills). Pass session_id to continue a conversation.',
    scope: 'agent',
    inputSchema: obj({ input: s('Task or message'), session_id: s('Existing session id'), pattern: s('react, plan-execute, reflexion, ... or auto'), model: s('Model id or auto') }, ['input']),
    async run(b, p, a) {
      const r = await b.runAgent(p, String(a.input), { sessionId: a.session_id as string, pattern: a.pattern as string, model: a.model as string });
      return `${r.output}\n\n[session_id: ${r.sessionId}, run_id: ${r.runId}, status: ${r.status}]`;
    },
  },
  {
    name: 'run_workflow',
    description: 'Run a Mercury multi-agent workflow by name (or "auto").',
    scope: 'workflow',
    inputSchema: obj({ workflow: s('Workflow name'), input: s('Workflow input') }, ['workflow', 'input']),
    async run(b, p, a) {
      const r = await b.runWorkflow(p, String(a.workflow), String(a.input));
      return `${r.output}\n\n[run_id: ${r.runId}]`;
    },
  },
  {
    name: 'list_workflows',
    description: 'List available Mercury workflows.',
    scope: 'workflow',
    inputSchema: obj({}),
    async run(b) {
      return b.listWorkflows().map((w) => `- ${w.name} (${w.type}): ${w.description ?? ''}`).join('\n') || 'No workflows.';
    },
  },
  {
    name: 'memory_search',
    description: "Search the user's long-term Mercury memory.",
    scope: 'memory',
    inputSchema: obj({ query: s('Query'), k: { type: 'number', description: 'Max results' } }, ['query']),
    async run(b, p, a) {
      const items = await b.memorySearch(p, String(a.query), a.k as number | undefined);
      return items.map((i) => `- [${i.id}] ${i.content}`).join('\n') || 'Nothing found.';
    },
  },
  {
    name: 'memory_add',
    description: "Store a fact in the user's long-term Mercury memory.",
    scope: 'memory',
    inputSchema: obj({ content: s('Fact to remember') }, ['content']),
    run: (b, p, a) => b.memoryAdd(p, String(a.content)),
  },
  {
    name: 'skills_list',
    description: 'List Mercury skills.',
    scope: 'skills',
    inputSchema: obj({}),
    async run(b) {
      return b.skills().map((k) => `- ${k.name}: ${k.description}`).join('\n') || 'No skills.';
    },
  },
  {
    name: 'skill_get',
    description: 'Get the full instructions of a Mercury skill.',
    scope: 'skills',
    inputSchema: obj({ name: s('Skill name') }, ['name']),
    async run(b, _p, a) {
      return b.skillBody(String(a.name));
    },
  },
  {
    name: 'schedule_list',
    description: 'List scheduled Mercury jobs.',
    scope: 'schedule',
    inputSchema: obj({}),
    async run(b, p) {
      return JSON.stringify(b.scheduleList(p), null, 1);
    },
  },
  {
    name: 'schedule_create',
    description: 'Create a scheduled Mercury job ("every weekday at 9am", cron, "in 10 minutes").',
    scope: 'schedule',
    inputSchema: obj({ when: s('When'), task: s('Prompt to run') }, ['when', 'task']),
    async run(b, p, a) {
      return JSON.stringify(await b.scheduleCreate(p, String(a.when), String(a.task)));
    },
  },
];

const TOOL_PREFIX = 'mercury_';

/** Build an MCP Server bound to one authenticated principal. */
export function createMcpServer(backend: McpBackend, principal: Principal): Server {
  const server = new Server({ name: 'mercury', version: '0.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  const allowed = (scope: string) => hasScope(principal, 'mcp') && hasScope(principal, scope);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const meta = META_TOOLS.filter((t) => allowed(t.scope)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const direct = allowed('tools')
      ? backend.toolSpecs(principal).map((t) => ({ name: `${TOOL_PREFIX}${t.name}`.slice(0, 64), description: t.description, inputSchema: { type: 'object' as const, ...(t.parameters as object) } }))
      : [];
    return { tools: [...meta, ...direct] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const meta = META_TOOLS.find((t) => t.name === name);
      if (meta) {
        if (!allowed(meta.scope)) throw new Error(`token lacks scope "${meta.scope}"`);
        return { content: [{ type: 'text' as const, text: await meta.run(backend, principal, args) }] };
      }
      if (name.startsWith(TOOL_PREFIX)) {
        if (!allowed('tools')) throw new Error('token lacks scope "tools"');
        const r = await backend.callTool(principal, name.slice(TOOL_PREFIX.length), args);
        return { content: [{ type: 'text' as const, text: r.content }], isError: r.isError === true };
      }
      throw new Error(`unknown tool ${name}`);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...(allowed('skills') ? backend.skills().map((k) => ({ uri: `skill://${k.name}`, name: k.name, description: k.description, mimeType: 'text/markdown' })) : []),
      ...(allowed('memory')
        ? [
            { uri: 'memory://MEMORY.md', name: 'MEMORY.md', mimeType: 'text/markdown' },
            { uri: 'memory://USER.md', name: 'USER.md', mimeType: 'text/markdown' },
          ]
        : []),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    let text: string;
    if (uri.startsWith('skill://') && allowed('skills')) text = backend.skillBody(uri.slice(8));
    else if (uri === 'memory://MEMORY.md' && allowed('memory')) text = backend.readCurated(principal, 'memory');
    else if (uri === 'memory://USER.md' && allowed('memory')) text = backend.readCurated(principal, 'user');
    else throw new Error(`resource not found or not permitted: ${uri}`);
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: allowed('skills') ? backend.skills().map((k) => ({ name: k.name, description: k.description, arguments: [{ name: 'task', description: 'What to apply the skill to', required: false }] })) : [],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (!allowed('skills')) throw new Error('token lacks scope "skills"');
    const body = backend.skillBody(req.params.name);
    const task = req.params.arguments?.task ?? '';
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Follow this skill:\n\n${body}${task ? `\n\nTask: ${task}` : ''}` } }] };
  });

  return server;
}

/** Serve over stdio (used by `mercury mcp serve`). */
export async function serveStdio(backend: McpBackend, principal: Principal): Promise<Server> {
  const server = createMcpServer(backend, principal);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Handle one Streamable HTTP request in stateless mode (a fresh server+transport per
 * request — simple and horizontally scalable). The caller authenticates first.
 */
export async function handleMcpHttp(backend: McpBackend, principal: Principal, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createMcpServer(backend, principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
