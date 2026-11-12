/**
 * Unified message, tool and attachment schema shared by every LLM provider,
 * tool, adapter and front-end. Providers translate to/from their wire format.
 */

/** How much we trust a piece of content. Ordered from most to least trusted. */
export type TrustLevel = 'system' | 'user' | 'trusted_tool' | 'untrusted';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type AttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'other';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** Absolute path on disk (attachment store). */
  path?: string;
  /** Remote URL (adapters may provide this before download). */
  url?: string;
  /** Base64 payload for small inline attachments (e.g. images sent to vision models). */
  data?: string;
  /** Transcript produced by STT for audio/video. */
  transcript?: string;
  /** Text description / extracted text (vision fallback, PDF text, frames). */
  description?: string;
  /** Paths of extracted video frames (if ffmpeg is available). */
  frames?: string[];
  trust?: TrustLevel;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  attachments?: Attachment[];
  /** Tool calls requested by the assistant. */
  toolCalls?: ToolCall[];
  /** For role=tool: id of the call this message answers. */
  toolCallId?: string;
  /** For role=tool: tool name. */
  name?: string;
  /** True when content came from an untrusted source (tool output, web, e-mail...). */
  untrusted?: boolean;
}

/** JSON schema (subset) used to describe tool parameters to LLMs. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRequest {
  /** Model id without provider prefix (provider already resolved). */
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | string;
}

/** Called with incremental text while a response is streamed. */
export type DeltaHandler = (text: string) => void;

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  json: boolean;
  streaming: boolean;
  contextWindow: number;
}

export interface ModelInfo {
  /** Fully qualified id: "<provider>/<model>". */
  id: string;
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
}
