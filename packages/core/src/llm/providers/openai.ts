/**
 * OpenAI Chat Completions compatible provider. Serves OpenAI, OpenRouter, LM Studio,
 * Ollama (/v1), vLLM, llama.cpp server and any other OpenAI-compatible endpoint.
 */
import type { DeltaHandler, LLMRequest, LLMResponse, ModelCapabilities, ModelInfo, ToolCall } from '../../types/messages.js';
import { MercuryError, safeJsonParse } from '../../types/common.js';
import { nativeImages, textWithAttachments } from '../content.js';
import { guessCapabilities, postJson, sseData, type LLMProvider } from '../provider.js';

export interface OpenAICompatibleOptions {
  id: string;
  type?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  capabilityOverrides?: (model: string) => Partial<ModelCapabilities> | undefined;
}

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  lmstudio: 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434/v1',
  // Abacus.AI ChatLLM / RouteLLM OpenAI-compatible endpoint.
  chatllm: 'https://routellm.abacus.ai/v1',
};

/**
 * Cloud provider types that cannot work without an API key, mapped to the env var that supplies it.
 * Local/self-hosted endpoints (ollama, lmstudio, openai-compatible) are intentionally absent — they
 * may run without any key, so they are never blocked here.
 */
export const KEY_REQUIRED_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  chatllm: 'CHATLLM_API_KEY',
};

type WireMessage = Record<string, unknown>;

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly type: string;
  constructor(private opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.type = opts.type ?? 'openai-compatible';
  }

  capabilities(model: string): ModelCapabilities {
    return { ...guessCapabilities(model), ...this.opts.capabilityOverrides?.(model) };
  }

  /**
   * Fail fast with an actionable message when a key-requiring cloud provider has no API key.
   * Without this, a keyless provider silently sends a request with no Authorization header and the
   * upstream returns a cryptic 401 ("Missing Authentication header" / "No cookie auth credentials
   * found") that gives the user no hint about what to fix.
   */
  private ensureAuth(): void {
    const envName = KEY_REQUIRED_ENV[this.type];
    if (envName && !this.opts.apiKey) {
      throw new MercuryError(
        `No API key for provider "${this.id}". Set ${envName} in ~/.mercury/.env (or llm.providers.${this.id}.apiKey in config.yaml). ` +
          `Note: keys in a ./.env of the current directory, or an exported shell variable of the same name, take precedence and can shadow ~/.mercury/.env.`,
        'missing_api_key',
        'models',
        401,
      );
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...this.opts.headers };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.type === 'openrouter') {
      h['HTTP-Referer'] ??= 'https://github.com/mercury-agent/mercury';
      h['X-Title'] ??= 'Mercury';
    }
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => ({ id: `${this.id}/${m.id}`, provider: this.id, model: m.id, capabilities: this.capabilities(m.id) }));
  }

  toWire(req: LLMRequest): WireMessage[] {
    const caps = this.capabilities(req.model);
    return req.messages.map((m): WireMessage => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
            : {}),
        };
      }
      const images = nativeImages(m, caps);
      const text = textWithAttachments(m, caps, images.length > 0);
      if (!images.length) return { role: m.role, content: text };
      return {
        role: m.role,
        content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }))],
      };
    });
  }

  async chat(req: LLMRequest, onDelta?: DeltaHandler): Promise<LLMResponse> {
    this.ensureAuth();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.toWire(req),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stop: req.stop,
    };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.responseFormat === 'json') body.response_format = { type: 'json_object' };
    if (onDelta) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const res = await postJson(`${this.opts.baseUrl}/chat/completions`, body, this.headers(), req.signal, this.opts.timeoutMs);
    return onDelta ? this.readStream(res, req.model, onDelta) : this.readJson(res, req.model);
  }

  private async readJson(res: Response, model: string): Promise<LLMResponse> {
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeJsonParse<Record<string, unknown>>(c.function.arguments || '{}') ?? {},
    }));
    return {
      content: choice?.message?.content ?? '',
      toolCalls,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      model: json.model ?? model,
      finishReason: toolCalls.length ? 'tool_calls' : (choice?.finish_reason ?? 'stop'),
    };
  }

  private async readStream(res: Response, model: string, onDelta: DeltaHandler): Promise<LLMResponse> {
    let content = '';
    let finish = 'stop';
    let usage = { inputTokens: 0, outputTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      const chunk = safeJsonParse<{
        choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(data);
      if (!chunk) continue;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        content += choice.delta.content;
        onDelta(choice.delta.content);
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = [...calls.values()].map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: safeJsonParse<Record<string, unknown>>(c.args || '{}') ?? {} }));
    return { content, toolCalls, usage, model, finishReason: toolCalls.length ? 'tool_calls' : finish };
  }
}
