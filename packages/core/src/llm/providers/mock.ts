/**
 * Offline, deterministic mock provider. Lets Mercury run end-to-end without API keys.
 *
 * Models:
 *   mock/echo        — native tool calling; echoes the user's message.
 *   mock/react-text  — no native tools; emits text ReAct ("Action: ...") to exercise the fallback.
 *   mock/vision      — like echo, reports attached images.
 *
 * Behaviour (echo):
 *   - `call:<tool> {json}` in the last user message → requests that tool call.
 *   - "calculate 2+3*4" → calls `calculator` when available.
 *   - "remember that ..." → calls `memory_remember` when available.
 *   - After tool results → summarises them ("Tool <name> returned: ...").
 *   - JSON mode → returns a JSON object (plans, critiques, decisions) derived from the prompt.
 *   - Otherwise → "Echo: <message>".
 * Tests can also queue scripted responses with `enqueue()`.
 */
import type { ChatMessage, DeltaHandler, LLMRequest, LLMResponse, ModelCapabilities, ModelInfo, ToolCall } from '../../types/messages.js';
import { estimateTokens, newId, safeJsonParse } from '../../types/common.js';
import { DEFAULT_CAPS, type LLMProvider } from '../provider.js';

const MODELS = ['echo', 'react-text', 'vision'];

export class MockProvider implements LLMProvider {
  readonly id: string;
  readonly type = 'mock';
  private queue: Array<Partial<LLMResponse> | ((req: LLMRequest) => Partial<LLMResponse>)> = [];
  /** Every request seen (handy for assertions in tests). */
  readonly calls: LLMRequest[] = [];

  constructor(id = 'mock', private latencyMs = 0) {
    this.id = id;
  }

  capabilities(model: string): ModelCapabilities {
    return { ...DEFAULT_CAPS, tools: model !== 'react-text', vision: model === 'vision', contextWindow: 32_000 };
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS.map((m) => ({ id: `${this.id}/${m}`, provider: this.id, model: m, capabilities: this.capabilities(m) }));
  }

  /** Queue scripted responses (FIFO) that take precedence over the built-in behaviour. */
  enqueue(...responses: Array<Partial<LLMResponse> | ((req: LLMRequest) => Partial<LLMResponse>)>): void {
    this.queue.push(...responses);
  }

  async chat(req: LLMRequest, onDelta?: DeltaHandler): Promise<LLMResponse> {
    this.calls.push(req);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (req.signal?.aborted) throw new Error('aborted');
    const scripted = this.queue.shift();
    const partial = scripted ? (typeof scripted === 'function' ? scripted(req) : scripted) : this.respond(req);
    const content = partial.content ?? '';
    if (onDelta && content) for (const piece of content.match(/\S+\s*/g) ?? []) onDelta(piece);
    const input = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const toolCalls = partial.toolCalls ?? [];
    return {
      content,
      toolCalls,
      usage: partial.usage ?? { inputTokens: input, outputTokens: estimateTokens(content) + toolCalls.length * 10 },
      model: req.model,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }

  private respond(req: LLMRequest): Partial<LLMResponse> {
    const last = req.messages[req.messages.length - 1];
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const userText = stripUntrusted(lastUser?.content ?? '');
    if (req.responseFormat === 'json') return { content: JSON.stringify(jsonAnswer(req.messages, userText)) };

    // After tool results: summarise them.
    const textReactObs = last?.role === 'user' && last.content.startsWith('Observation:');
    if (last?.role === 'tool' || textReactObs) {
      const results = trailingToolResults(req.messages);
      return { content: `Here is what I found.\n${results}` };
    }

    const call = planToolCall(userText, req);
    if (call) {
      if (req.model === 'react-text' || !req.tools?.length) {
        return { content: `Thought: I should use ${call.name}.\nAction: ${call.name}\nAction Input: ${JSON.stringify(call.arguments)}` };
      }
      return { toolCalls: [call] };
    }
    const images = (lastUser?.attachments ?? []).filter((a) => a.kind === 'image');
    const imageNote = images.length ? ` (I received ${images.length} image(s): ${images.map((i) => i.name).join(', ')})` : '';
    const text = userText.trim() || '(empty message)';
    return { content: req.model === 'react-text' ? `Final Answer: Echo: ${text}` : `Echo: ${text}${imageNote}` };
  }
}

function stripUntrusted(text: string): string {
  return text.replace(/<untrusted_content[\s\S]*?<\/untrusted_content[^>]*>/g, '').trim();
}

function trailingToolResults(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'tool') out.unshift(`- ${m.name ?? 'tool'}: ${m.content.replace(/<\/?untrusted_content[^>]*>/g, '').trim().slice(0, 400)}`);
    else if (m.role === 'user' && m.content.startsWith('Observation:')) out.unshift(`- ${m.content.slice(12).trim().slice(0, 400)}`);
    else break;
  }
  return out.join('\n');
}

function planToolCall(text: string, req: LLMRequest): ToolCall | undefined {
  const names = new Set((req.tools ?? []).map((t) => t.name));
  const textMode = req.model === 'react-text';
  const has = (n: string) => names.has(n) || (textMode && req.messages.some((m) => m.role === 'system' && m.content.includes(`- ${n}:`)));
  const explicit = /call:([\w.-]+)\s*(\{[\s\S]*\})?/.exec(text);
  if (explicit && has(explicit[1]!)) {
    return { id: newId('call'), name: explicit[1]!, arguments: safeJsonParse<Record<string, unknown>>(explicit[2] ?? '{}') ?? {} };
  }
  const calc = /\b(?:calculate|compute|what is)\s+([-+*/().\d\s^%]+\d\)?)/i.exec(text);
  if (calc && has('calculator')) return { id: newId('call'), name: 'calculator', arguments: { expression: calc[1]!.trim() } };
  const remember = /\bremember (?:that )?(.+)/i.exec(text);
  if (remember && has('memory_remember')) return { id: newId('call'), name: 'memory_remember', arguments: { content: remember[1]!.trim() } };
  return undefined;
}

/** Deterministic JSON answers for the structured prompts used by patterns/reflection. */
function jsonAnswer(messages: ChatMessage[], userText: string): Record<string, unknown> {
  const prompt = messages.map((m) => m.content).join('\n');
  if (/"steps"/.test(prompt)) {
    const goal = /GOAL:\s*(.+)/.exec(prompt)?.[1] ?? userText;
    const parts = goal.split(/\s+(?:and then|then|and)\s+/i).filter(Boolean).slice(0, 4);
    return { steps: parts.length ? parts : [goal] };
  }
  if (/"approaches"/.test(prompt)) return { approaches: ['Direct answer', 'Step-by-step analysis', 'Use tools to verify'] };
  if (/"lessons"/.test(prompt)) return { lessons: [], userObservations: [] };
  if (/"skill"/.test(prompt)) return { skill: null };
  if (/"summary"/.test(prompt)) return { summary: userText.slice(0, 200) };
  if (/"answers"/.test(prompt)) {
    // LLM decision provider format: echo a neutral answer per question id.
    const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]!);
    return { answers: Object.fromEntries(ids.map((id) => [id, { value: 0.5, confidence: 0.5 }])) };
  }
  return { result: userText };
}
