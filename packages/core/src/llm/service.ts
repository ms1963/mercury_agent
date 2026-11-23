/**
 * LLMService — the single gateway through which every model call flows:
 * routing → RBAC → budget pre-check → provider call (retries, fallback chain,
 * text-ReAct adaptation for tool-less models) → usage ledger → events/hooks.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { BudgetService } from '../budgets/budgets.js';
import { costOf } from '../budgets/budgets.js';
import { currentBudgetOwner } from '../budgets/attribution.js';
import type { TaskBudgetService } from '../budgets/task-budgets.js';
import type { PolicyEngine } from '../auth/policy.js';
import type { EventBus } from '../events/bus.js';
import type { ModelRouter, RouteDecision } from '../router/router.js';
import { BudgetExceededError, MercuryError, PermissionDeniedError, errorMessage, estimateTokens, sleep, type Principal } from '../types/common.js';
import type { ChatMessage, DeltaHandler, LLMResponse, ToolSpec } from '../types/messages.js';
import type { ProviderRegistry } from './registry.js';
import { ProviderError } from './provider.js';
import { backoffDelay } from './backoff.js';
import { CircuitBreaker, CircuitOpenError } from '../reliability/index.js';
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
    /** Optional per-task hard budgets; when present, over-budget tasks are halted/escalated. */
    private taskBudgets?: TaskBudgetService,
  ) {}

  /** One circuit breaker per model id (lazily created). */
  private readonly breakers = new Map<string, CircuitBreaker>();

  /**
   * Returns the circuit breaker for a model id, creating it on first use. Only
   * genuinely retryable provider errors (429/5xx/network) count as failures, so a
   * 4xx/validation error never trips the breaker. State changes are published on the
   * event bus as `llm.circuit` events for observability.
   */
  private breakerFor(modelId: string): CircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      const cb = this.config.llm.circuitBreaker;
      breaker = new CircuitBreaker({
        name: modelId,
        failureThreshold: cb.failureThreshold,
        successThreshold: cb.halfOpenSuccesses,
        cooldownMs: cb.cooldownMs,
        windowMs: cb.windowMs,
        isFailure: (err) => err instanceof ProviderError && err.retryable,
        onStateChange: (change) => this.bus.emit({ type: 'llm.circuit', data: { model: modelId, from: change.from, to: change.to } }),
      });
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

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
    // An auxiliary (system) call made on behalf of a user is checked against and charged to that
    // user's budget. Security decisions (kind 'decision') stay exempt so a spent budget can never
    // disable the approval gate (they remain capped by an explicit 'system' rule).
    const owner = call.principal.kind === 'system' && call.kind !== 'decision' ? currentBudgetOwner() : undefined;
    this.budgets.check(call.principal, modelId, estimate, call.budgetOverride);
    if (owner) this.budgets.check(owner, modelId, estimate, false);
    // Per-task hard budget: stop a task before it spends past its cap (throws to halt/escalate).
    const profile = this.registry.profile(modelId);
    const estimatedCost = costOf(profile, { inputTokens: estimate, outputTokens: 0 });
    this.taskBudgets?.check(call.runId, estimatedCost, estimate, call.budgetOverride);

    const textMode = !!call.tools?.length && !caps.tools && this.config.agent.textReactFallback;
    let messages = textMode ? toTextReact(call.messages, call.tools!) : call.messages;
    const before = await this.hooks?.run('before_llm_call', { model: modelId, messages, runId: call.runId });
    if (before?.messages) messages = before.messages as ChatMessage[];

    this.bus.emit({ type: 'llm.request', runId: call.runId, sessionId: call.sessionId, userId: call.principal.userId, data: { model: modelId, messages: messages.length, tools: call.tools?.length ?? 0, textMode } });
    const started = Date.now();
    // The provider call + bounded retry loop (built on the shared backoffDelay).
    const runWithRetries = async (): Promise<LLMResponse> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await provider.chat(
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
        } catch (err) {
          const retryable = err instanceof ProviderError && err.retryable;
          if (!retryable || attempt >= this.config.llm.retries || call.signal?.aborted) throw err;
          const delay = backoffDelay(attempt, this.config.llm.retryBackoffMs, this.config.llm.retryJitter);
          this.bus.emit({ type: 'llm.retry', runId: call.runId, data: { model: modelId, attempt: attempt + 1, maxRetries: this.config.llm.retries, delayMs: delay, error: errorMessage(err) } });
          await sleep(delay, call.signal);
        }
      }
    };

    // Wrap the whole retry loop in a per-model circuit breaker so a model that keeps
    // failing with retryable errors is skipped fast (and chat() falls back to the
    // next model). Disablable via config.llm.circuitBreaker.enabled.
    let res: LLMResponse;
    if (this.config.llm.circuitBreaker.enabled) {
      try {
        res = await this.breakerFor(modelId).exec(runWithRetries);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          this.bus.emit({ type: 'llm.circuit_open', runId: call.runId, data: { model: modelId, retryAfterMs: err.retryAfterMs } });
        }
        throw err;
      }
    } else {
      res = await runWithRetries();
    }
    if (textMode) {
      const parsed = parseTextReact(res.content);
      res = { ...res, content: parsed.finalAnswer ?? '', toolCalls: parsed.toolCall ? [parsed.toolCall] : [], finishReason: parsed.toolCall ? 'tool_calls' : 'stop' };
      if (parsed.thought) this.bus.emit({ type: 'thought', runId: call.runId, data: { text: parsed.thought } });
    }
    const durationMs = Date.now() - started;
    const cost = costOf(this.registry.profile(modelId), res.usage);
    this.budgets.record(owner?.userId ?? call.principal.userId, modelId, res.usage, cost, call.kind ?? 'chat', call.runId);
    // Per-task running cost ledger (single source of truth; the bus `llm.response` hook is not used).
    this.taskBudgets?.record(call.runId, cost, res.usage.inputTokens, res.usage.outputTokens);
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
