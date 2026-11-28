/**
 * Anthropic Messages API provider (native tool use, vision, streaming).
 */
import type { DeltaHandler, LLMRequest, LLMResponse, ModelCapabilities, ModelInfo, ToolCall } from '../../types/messages.js';
import { MercuryError, safeJsonParse } from '../../types/common.js';
import { nativeImages, textWithAttachments } from '../content.js';
import { guessCapabilities, postJson, sseData, type LLMProvider } from '../provider.js';

export interface AnthropicOptions {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

type Block = Record<string, unknown>;

/** Shape of the Anthropic Messages streaming SSE events we consume. */
interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly type = 'anthropic';
  private baseUrl: string;
  constructor(private opts: AnthropicOptions) {
    this.id = opts.id ?? 'anthropic';
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com/v1';
  }

  capabilities(model: string): ModelCapabilities {
    return { ...guessCapabilities(model), vision: true, contextWindow: 200_000 };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res?.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => ({ id: `${this.id}/${m.id}`, provider: this.id, model: m.id, capabilities: this.capabilities(m.id) }));
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.opts.apiKey ?? '', 'anthropic-version': '2023-06-01' };
  }

  /** Anthropic wants system separately and tool results as user content blocks. */
  toWire(req: LLMRequest): { system: string; messages: Array<{ role: string; content: Block[] }> } {
    const caps = this.capabilities(req.model);
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages: Array<{ role: string; content: Block[] }> = [];
    const push = (role: string, blocks: Block[]) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
      } else if (m.role === 'assistant') {
        const blocks: Block[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        push('assistant', blocks.length ? blocks : [{ type: 'text', text: '' }]);
      } else {
        const images = nativeImages(m, caps);
        push('user', [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })),
          { type: 'text', text: textWithAttachments(m, caps, images.length > 0) || ' ' },
        ]);
      }
    }
    return { system, messages };
  }

  async chat(req: LLMRequest, onDelta?: DeltaHandler): Promise<LLMResponse> {
    if (!this.opts.apiKey) {
      throw new MercuryError(
        `No API key for provider "${this.id}". Set ANTHROPIC_API_KEY in ~/.mercury/.env (or llm.providers.${this.id}.apiKey in config.yaml). ` +
          `Note: keys in a ./.env of the current directory, or an exported shell variable of the same name, take precedence and can shadow ~/.mercury/.env.`,
        'missing_api_key',
        'models',
        401,
      );
    }
    const { system, messages } = this.toWire(req);
    const body: Record<string, unknown> = {
      model: req.model,
      system: req.responseFormat === 'json' ? `${system}\n\nRespond with a single JSON object only.` : system,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      stop_sequences: req.stop,
      stream: !!onDelta,
    };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const res = await postJson(`${this.baseUrl}/messages`, body, this.headers(), req.signal, this.opts.timeoutMs);
    return onDelta ? this.readStream(res, req.model, onDelta) : this.readJson(res, req.model);
  }

  private async readJson(res: Response, model: string): Promise<LLMResponse> {
    const json = (await res.json()) as { content?: Block[]; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string; model?: string };
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const b of json.content ?? []) {
      if (b.type === 'text') content += String(b.text ?? '');
      if (b.type === 'tool_use') toolCalls.push({ id: String(b.id), name: String(b.name), arguments: (b.input as Record<string, unknown>) ?? {} });
    }
    return {
      content,
      toolCalls,
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
      model: json.model ?? model,
      finishReason: toolCalls.length ? 'tool_calls' : (json.stop_reason ?? 'stop'),
    };
  }

  private async readStream(res: Response, model: string, onDelta: DeltaHandler): Promise<LLMResponse> {
    let content = '';
    const usage = { inputTokens: 0, outputTokens: 0 };
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let stop = 'stop';
    for await (const data of sseData(res)) {
      const ev = safeJsonParse<AnthropicStreamEvent>(data);
      if (!ev) continue;
      if (ev.type === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
        blocks.set(ev.index, { id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', json: '' });
      }
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text !== undefined) {
          content += ev.delta.text;
          onDelta(ev.delta.text);
        }
        if (ev.delta?.type === 'input_json_delta' && ev.index !== undefined) {
          const b = blocks.get(ev.index);
          if (b) b.json += ev.delta.partial_json ?? '';
        }
      }
      if (ev.type === 'message_delta') {
        usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
        stop = ev.delta?.stop_reason ?? stop;
      }
    }
    const toolCalls = [...blocks.values()].map((b) => ({ id: b.id, name: b.name, arguments: safeJsonParse<Record<string, unknown>>(b.json || '{}') ?? {} }));
    return { content, toolCalls, usage, model, finishReason: toolCalls.length ? 'tool_calls' : stop };
  }
}
