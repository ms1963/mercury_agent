/**
 * LLMService — the single gateway through which every model call flows:
 * routing → RBAC → budget pre-check → provider call (retries, fallback chain,
 * text-ReAct adaptation for tool-less models) → usage ledger → events/hooks.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { BudgetService } from '../budgets/budgets.js';
import { costOf } from '../budgets/budgets.js';
import type { PolicyEngine } from '../auth/policy.js';
import type { EventBus } from '../events/bus.js';
import type { ModelRouter, RouteDecision } from '../router/router.js';
import { BudgetExceededError, MercuryError, PermissionDeniedError, errorMessage, estimateTokens, sleep, type Principal } from '../types/common.js';
import type { ChatMessage, DeltaHandler, LLMResponse, ToolSpec } from '../types/messages.js';
import type { ProviderRegistry } from './registry.js';
import { ProviderError } from './provider.js';
import { parseTextReact, textReactInstructions } from './text-react.js';
import type { HookManager } from '../plugins/hooks.js';

export interface ChatCall {
  principal: Principal;
  messages: ChatMessage[];
  /** Concrete "<provider>/<model>" or "auto"/undefined for routing. */
  model?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  onDelta?: DeltaHandler;
  signal?: AbortSignal;
  runId?: string;
  sessionId?: string;
  /** Text used by the router (defaults to the last user message). */
  task?: string;
  tags?: string[];
  budgetOverride?: boolean;
  /** Usage ledger category: chat | decision | reflection | summary | embedding. */
  kind?: string;
}

export interface ChatResult extends LLMResponse {
  modelId: string;
  route?: RouteDecision;
  cost: number;
  durationMs: number;
  textMode: boolean;
}

export class LLMService {
  constructor(
    private config: MercuryConfig,
    readonly registry: ProviderRegistry,
    readonly router: ModelRouter,
    private budgets: BudgetService,
    private policy: PolicyEngine,
    private bus: EventBus,
    private hooks?: HookManager,
  ) {}

  async chat(call: ChatCall): Promise<ChatResult> {
    const task = call.task ?? [...call.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const needs = {
      tools: !!call.tools?.length,
      vision: call.messages.some((m) => m.attachments?.some((a) => a.kind === 'image' || (a.kind === 'video' && a.frames?.length))),
    };
    const route = await this.router.route({
      task,
      explicitModel: call.model,
      tags: call.tags,
      needs: { tools: needs.tools, vision: needs.vision },
      allowed: (m) => this.policy.can(call.principal, 'model.use', { model: m }),
      runId: call.runId,
    });
    const attempts = [route.model, ...route.fallbacks];
    const errors: string[] = [];
    for (const modelId of attempts) {
      try {
        const res = await this.callModel(modelId, call);
        return { ...res, route };
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof PermissionDeniedError || call.signal?.aborted) throw err;
        errors.push(`${modelId}: ${errorMessage(err)}`);
        this.bus.emit({ type: 'llm.error', runId: call.runId, data: { model: modelId, error: errorMessage(err), willFallback: modelId !== attempts[attempts.length - 1] } });
      }
    }
    throw new MercuryError(`All models failed. ${errors.join(' | ')}`, 'llm_failed', 'models', 502);
  }

  private async callModel(modelId: string, call: ChatCall): Promise<Omit<ChatResult, 'route'>> {
    this.policy.assert(call.principal, 'model.use', { model: modelId });
    const { provider, model } = this.registry.resolve(modelId);
    const caps = this.registry.capabilities(modelId);
    const estimate = call.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + (call.maxTokens ?? 512);
    this.budgets.check(call.principal, modelId, estimate, call.budgetOverride);

    const textMode = !!call.tools?.length && !caps.tools && this.config.agent.textReactFallback;
    let messages = textMode ? toTextReact(call.messages, call.tools!) : call.messages;
    const before = await this.hooks?.run('before_llm_call', { model: modelId, messages, runId: call.runId });
    if (before?.messages) messages = before.messages as ChatMessage[];

    this.bus.emit({ type: 'llm.request', runId: call.runId, sessionId: call.sessionId, userId: call.principal.userId, data: { model: modelId, messages: messages.length, tools: call.tools?.length ?? 0, textMode } });
    const started = Date.now();
    let res: LLMResponse | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await provider.chat(
          {
            model,
            messages,
            tools: textMode ? undefined : call.tools,
            temperature: call.temperature ?? this.config.agent.temperature,
            maxTokens: call.maxTokens,
            responseFormat: call.responseFormat,
            signal: call.signal,
            stop: textMode ? ['\nObservation:'] : undefined,
          },
          call.onDelta
            ? (d) => {
                call.onDelta!(d);
                this.bus.emit({ type: 'llm.delta', runId: call.runId, sessionId: call.sessionId, data: { text: d } });
              }
            : undefined,
        );
        break;
      } catch (err) {
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable || attempt >= this.config.llm.retries || call.signal?.aborted) throw err;
        await sleep(500 * 2 ** attempt, call.signal);
      }
    }
    if (textMode) {
      const parsed = parseTextReact(res.content);
      res = { ...res, content: parsed.finalAnswer ?? '', toolCalls: parsed.toolCall ? [parsed.toolCall] : [], finishReason: parsed.toolCall ? 'tool_calls' : 'stop' };
      if (parsed.thought) this.bus.emit({ type: 'thought', runId: call.runId, data: { text: parsed.thought } });
    }
    const durationMs = Date.now() - started;
    const cost = costOf(this.registry.profile(modelId), res.usage);
    this.budgets.record(call.principal.userId, modelId, res.usage, cost, call.kind ?? 'chat', call.runId);
    this.bus.emit({
      type: 'llm.response',
      runId: call.runId,
      sessionId: call.sessionId,
      userId: call.principal.userId,
      data: { model: modelId, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cost, durationMs, toolCalls: res.toolCalls.map((t) => t.name), content: res.content.slice(0, 2000) },
    });
    await this.hooks?.run('after_llm_call', { model: modelId, response: res, runId: call.runId });
    return { ...res, modelId, cost, durationMs, textMode };
  }

  /** Convenience: one-shot completion returning text (used by summaries, reflection, decisions). */
  async complete(principal: Principal, messages: ChatMessage[], opts: Partial<ChatCall> = {}): Promise<ChatResult> {
    return this.chat({ principal, messages, kind: 'auxiliary', ...opts });
  }
}

/** Convert native tool-call transcripts into the text-ReAct protocol. */
function toTextReact(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const instructions = textReactInstructions(tools);
  let injected = false;
  for (const m of messages) {
    if (m.role === 'system' && !injected) {
      out.push({ ...m, content: `${m.content}\n\n${instructions}` });
      injected = true;
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const c = m.toolCalls[0]!;
      out.push({ role: 'assistant', content: `${m.content ? `Thought: ${m.content}\n` : ''}Action: ${c.name}\nAction Input: ${JSON.stringify(c.arguments)}` });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: `Observation: ${m.content}` });
    } else out.push(m);
  }
  if (!injected) out.unshift({ role: 'system', content: instructions });
  return out;
}
