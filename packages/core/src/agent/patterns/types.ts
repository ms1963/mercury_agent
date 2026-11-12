/**
 * Reasoning patterns (ReAct, Plan-and-Execute, Reflexion, CoT, ToT-lite,
 * Self-Consistency, Critic) all implement this small interface. A pattern receives
 * a PatternContext with two primitives — `loop()` (tool-using ReAct loop) and
 * `complete()` (single LLM call) — and composes them into a strategy.
 */
import type { Judgment } from '../../decision/judgment.js';
import type { Principal } from '../../types/common.js';
import type { ChatMessage, DeltaHandler } from '../../types/messages.js';

export interface LoopOptions {
  maxIterations?: number;
  /** Offer tools to the model (default true). */
  tools?: boolean;
  /** Stream final text deltas to the user. */
  stream?: boolean;
  temperature?: number;
}

export interface LoopResult {
  output: string;
  /** Messages produced during the loop (assistant/tool), excluding the input messages. */
  newMessages: ChatMessage[];
  toolCalls: number;
  iterations: number;
  /** True if the iteration limit was hit before a final answer. */
  exhausted: boolean;
}

export interface CompleteOptions {
  json?: boolean;
  temperature?: number;
  stream?: boolean;
  maxTokens?: number;
}

export interface PatternContext {
  task: string;
  /** System prompt + history + current user message. */
  messages: ChatMessage[];
  runId: string;
  principal: Principal;
  signal: AbortSignal;
  judgment: Judgment;
  loop(messages: ChatMessage[], opts?: LoopOptions): Promise<LoopResult>;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  emit(type: string, data: Record<string, unknown>): void;
  onDelta?: DeltaHandler;
}

export interface PatternResult {
  output: string;
  /** Messages to persist in the session after the user message. */
  newMessages: ChatMessage[];
  toolCalls: number;
  meta?: Record<string, unknown>;
}

export interface Pattern {
  name: string;
  /** One-line description (also used by the decision engine for pattern selection). */
  description: string;
  run(ctx: PatternContext): Promise<PatternResult>;
}

/** Wrap a single final answer as a PatternResult. */
export function finalAnswer(output: string, toolCalls = 0, meta?: Record<string, unknown>): PatternResult {
  return { output, newMessages: [{ role: 'assistant', content: output }], toolCalls, meta };
}
