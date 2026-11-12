/**
 * LLM provider interface. A provider talks to one backend (OpenAI, Anthropic, Ollama...)
 * and translates the unified schema to the backend's wire format.
 */
import type { DeltaHandler, LLMRequest, LLMResponse, ModelCapabilities, ModelInfo } from '../types/messages.js';

export interface LLMProvider {
  /** Provider id used as the model prefix, e.g. "openai" in "openai/gpt-4o". */
  readonly id: string;
  /** Wire type, e.g. "openai-compatible", "anthropic", "mock". */
  readonly type: string;
  capabilities(model: string): ModelCapabilities;
  listModels(): Promise<ModelInfo[]>;
  /** Perform a chat completion. When `onDelta` is given the provider should stream. */
  chat(req: LLMRequest, onDelta?: DeltaHandler): Promise<LLMResponse>;
}

export const DEFAULT_CAPS: ModelCapabilities = {
  tools: true,
  vision: false,
  audio: false,
  video: false,
  json: true,
  streaming: true,
  contextWindow: 8192,
};

/** Heuristic capabilities from well-known model names (overridable via config model profiles). */
export function guessCapabilities(model: string): ModelCapabilities {
  const m = model.toLowerCase();
  const caps = { ...DEFAULT_CAPS };
  if (/gpt-4o|gpt-4\.1|gpt-5|o[134]|claude-(3|sonnet|opus|haiku)|gemini|llava|vision|pixtral|qwen.*vl|llama-?4/.test(m)) caps.vision = true;
  if (/gpt-4o-audio|gemini/.test(m)) caps.audio = true;
  if (/gpt-4o|gpt-4\.1|gpt-5|o[134]|claude|gemini-1\.5|gemini-2/.test(m)) caps.contextWindow = 128_000;
  if (/claude/.test(m)) caps.contextWindow = 200_000;
  if (/gemini/.test(m)) caps.contextWindow = 1_000_000;
  if (/llama-?3|mistral|qwen|phi|gemma|deepseek/.test(m)) caps.contextWindow = 32_768;
  if (/gemma|phi-2|tinyllama|text-only|instruct-notools/.test(m)) caps.tools = false;
  return caps;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** POST JSON with timeout; throws ProviderError with retryable flag for 429/5xx/network. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal, timeoutMs = 120_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: combined });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError('aborted', undefined, false);
    throw new ProviderError(`network error calling ${new URL(url).host}: ${String(err)}`, undefined, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`, res.status, res.status === 429 || res.status >= 500);
  }
  return res;
}

/** Iterate over Server-Sent-Events `data:` payloads of a streaming response. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trimStart();
}
