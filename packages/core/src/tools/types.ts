/**
 * Tool contract. Built-in tools, polyglot tools, MCP tools and plugin tools all
 * implement this interface and are executed through the ToolExecutor pipeline.
 */
import type { ZodType } from 'zod';
import type { Principal } from '../types/common.js';
import type { Attachment, JsonSchema } from '../types/messages.js';
import type { ToolServices } from './services.js';

export type ToolRisk = 'safe' | 'moderate' | 'dangerous';

export interface ToolResult {
  content: string;
  data?: unknown;
  attachments?: Attachment[];
  isError?: boolean;
  /** Force untrusted tagging even if the tool is not flagged `untrustedOutput`. */
  untrusted?: boolean;
}

export interface ApprovalRequest {
  title: string;
  detail: string;
  risk: ToolRisk;
  tool?: string;
  args?: unknown;
}

export interface ToolContext {
  principal: Principal;
  runId?: string;
  sessionId?: string;
  /** Front-end the run came from: cli, web, telegram, mcp, scheduler... */
  platform: string;
  signal?: AbortSignal;
  /** Working directory for file/terminal tools (inside the path jail). */
  workdir: string;
  /** Subagent depth (0 = top-level agent). */
  depth: number;
  /** Toolsets this agent may use (subagents get restricted sets). Undefined = all enabled. */
  allowedToolsets?: string[];
  services: ToolServices;
  emit(type: string, data: Record<string, unknown>): void;
  /** Ask a human (or the configured policy) for approval. */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  toolset: string;
  /** JSON schema sent to the LLM. */
  parameters: JsonSchema;
  /** Optional zod schema for strict validation of arguments. */
  schema?: ZodType<A>;
  risk: ToolRisk;
  /** Output comes from outside (web, files, mail, MCP) → spotlighted as untrusted. */
  untrustedOutput?: boolean;
  /** Acts on the outside world (writes, sends, executes). Gated when context is untrusted. */
  sensitive?: boolean;
  /** Return a reason string (or true) when this specific call needs approval. */
  needsApproval?: (args: A, ctx: ToolContext) => string | boolean | undefined;
  timeoutMs?: number;
  /** Max characters of output passed back to the model. */
  maxOutputChars?: number;
  /** Where the tool comes from (builtin, polyglot, mcp:<server>, plugin:<name>). */
  source?: string;
  execute(args: A, ctx: ToolContext): Promise<ToolResult | string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

/** Helper for defining tools with type inference. */
export function defineTool<A>(tool: Tool<A>): Tool<A> {
  return tool;
}
