/**
 * Per-run mutable state shared by the loop, patterns and tools: identity, abort
 * signal, tool context, security state, usage accumulator and skill usage.
 */
import type { Principal } from '../types/common.js';
import type { DeltaHandler } from '../types/messages.js';
import type { RunSecurityState } from '../tools/executor.js';
import type { ToolContext } from '../tools/types.js';
import type { ChatResult } from '../llm/service.js';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  llmCalls: number;
}

export class RunState {
  readonly usage: RunUsage = { inputTokens: 0, outputTokens: 0, cost: 0, llmCalls: 0 };
  toolCalls = 0;
  readonly toolNames: string[] = [];
  readonly skillsUsed = new Set<string>();
  lastModel?: string;

  constructor(
    readonly runId: string,
    readonly sessionId: string,
    readonly principal: Principal,
    readonly platform: string,
    readonly depth: number,
    readonly controller: AbortController,
    readonly toolCtx: ToolContext,
    readonly security: RunSecurityState,
    readonly model: string | undefined,
    readonly allowedToolsets: string[] | undefined,
    readonly onDelta?: DeltaHandler,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  addUsage(res: ChatResult): void {
    this.usage.inputTokens += res.usage.inputTokens;
    this.usage.outputTokens += res.usage.outputTokens;
    this.usage.cost += res.cost;
    this.usage.llmCalls++;
    this.lastModel = res.modelId;
  }
}
