/** McpBackend implementation: what external MCP clients can do with Mercury. */
import { newId, type AcpAgent, type LspAgent, type Principal, type ToolContext } from '@mercury/core';
import type { McpBackend } from '@mercury/mcp';
import type { Mercury } from './mercury.js';

/** Build a tool context for direct tool calls (MCP, REST "try tool"). */
export function directToolContext(m: Mercury, principal: Principal, platform: string): ToolContext {
  return {
    principal,
    runId: newId('run'),
    platform,
    workdir: process.cwd(),
    depth: 0,
    services: m.services,
    emit: (type, data) => m.bus.emit({ type, userId: principal.userId, data }),
    requestApproval: (req) => m.approvals.request(req, { userId: principal.userId, platform }),
    approvalAnswerable: () => m.approvals.isAnswerable(platform),
  };
}

export function createBackend(m: Mercury): McpBackend {
  return {
    toolSpecs: () => m.tools.specs('mcp'),
    async callTool(principal, name, args) {
      const ctx = directToolContext(m, principal, 'mcp');
      const r = await m.executor.execute({ id: newId('call'), name, arguments: args }, ctx, { untrustedSeen: true, userRequest: `MCP call ${name}` });
      return { content: r.result.content, isError: !r.ok };
    },
    async runAgent(principal, input, opts) {
      const r = await m.agent.run({ principal, input, platform: 'mcp', kind: 'mcp', ...opts });
      return { output: r.output, sessionId: r.sessionId, runId: r.runId, status: r.status };
    },
    async runWorkflow(principal, workflow, input) {
      const r = await m.workflows.run(workflow, input, { principal, platform: 'mcp' });
      return { output: r.output, runId: r.runId };
    },
    listWorkflows: () => m.workflows.list().map((w) => ({ name: w.name, type: w.type, description: w.description })),
    async memorySearch(principal, query, k) {
      return (await m.memory.recall(principal.userId, query, k)).map((i) => ({ id: i.id, content: i.content }));
    },
    async memoryAdd(principal, content) {
      return (await m.memory.remember(principal.userId, content, { source: 'mcp' })).id;
    },
    readCurated: (principal, which) => m.memory.curated.read(principal.userId, which),
    skills: () => m.skills.list().map((s) => ({ name: s.meta.name, description: s.meta.description })),
    skillBody: (name) => m.skills.view(name),
    scheduleList: (principal) => m.scheduler.list(principal.userId) as unknown as Array<Record<string, unknown>>,
    scheduleCreate: (principal, when, task) => m.scheduler.create(principal.userId, { when, task }) as unknown as Record<string, unknown>,
  };
}

/**
 * ACP agent adapter: exposes the same underlying agent + tool surface as the MCP backend, bound to one
 * authenticated `principal` via closure (exactly as `serveStdio` binds a principal for MCP). The final
 * assistant output is returned to the ACP dispatch, which streams it as a single `agent_message_chunk`.
 */
export function createAcpAgent(m: Mercury, principal: Principal): AcpAgent {
  return {
    async runPrompt(input, opts) {
      const r = await m.agent.run({ principal, input, platform: 'acp', kind: 'mcp', sessionId: opts.sessionId });
      const stopReason = r.status === 'completed' ? 'end_turn' : r.status === 'stopped' ? 'cancelled' : 'error';
      return { output: r.output, stopReason };
    },
    toolSpecs: () => m.tools.specs('mcp'),
    async callTool(name, args) {
      const ctx = directToolContext(m, principal, 'acp');
      const r = await m.executor.execute({ id: newId('call'), name, arguments: args }, ctx, { untrustedSeen: true, userRequest: `ACP call ${name}` });
      return { content: r.result.content, isError: !r.ok };
    },
  };
}

/**
 * LSP agent adapter: the LSP server (`packages/core/src/lsp`) exposes the same agent + tool surface as
 * the ACP server to LSP-capable editors/IDEs. `LspAgent` aliases `AcpAgent`, so this binds the identical
 * closure over one authenticated `principal`; only the platform tag differs (`lsp`) for attribution.
 */
export function createLspAgent(m: Mercury, principal: Principal): LspAgent {
  return {
    async runPrompt(input, opts) {
      const r = await m.agent.run({ principal, input, platform: 'lsp', kind: 'mcp', sessionId: opts.sessionId });
      const stopReason = r.status === 'completed' ? 'end_turn' : r.status === 'stopped' ? 'cancelled' : 'error';
      return { output: r.output, stopReason };
    },
    toolSpecs: () => m.tools.specs('mcp'),
    async callTool(name, args) {
      const ctx = directToolContext(m, principal, 'lsp');
      const r = await m.executor.execute({ id: newId('call'), name, arguments: args }, ctx, { untrustedSeen: true, userRequest: `LSP call ${name}` });
      return { content: r.result.content, isError: !r.ok };
    },
  };
}
