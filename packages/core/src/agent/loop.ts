/**
 * The ReAct tool loop — the heart of every agent run:
 *
 *   repeat up to maxIterations:
 *     (compress context if near the window)
 *     [debug checkpoint: before LLM call]
 *     LLM call with tool specs (native tools, or text-ReAct fallback inside LLMService)
 *     no tool calls → final answer
 *     for each tool call: [debug checkpoint] → ToolExecutor (guarded) → tool message
 *   limit reached → one last call without tools asking for the best final answer
 */
import type { MercuryConfig } from '../config/schema.js';
import type { LLMService } from '../llm/service.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { EventBus } from '../events/bus.js';
import { MercuryError } from '../types/common.js';
import type { ChatMessage } from '../types/messages.js';
import { compressMessages, needsCompression } from './compression.js';
import type { DebugController } from './debug.js';
import type { LoopOptions, LoopResult } from './patterns/types.js';
import type { RunState } from './run-state.js';

export interface LoopDeps {
  config: MercuryConfig;
  llm: LLMService;
  tools: ToolRegistry;
  executor: ToolExecutor;
  debug: DebugController;
  bus: EventBus;
  summarize: (run: RunState, transcript: string) => Promise<string>;
}

export class RunStoppedError extends MercuryError {
  constructor() {
    super('Run stopped', 'run_stopped', 'agent', 499);
  }
}

export async function runToolLoop(deps: LoopDeps, run: RunState, input: ChatMessage[], opts: LoopOptions = {}): Promise<LoopResult> {
  const max = opts.maxIterations ?? deps.config.agent.maxIterations;
  let messages = [...input];
  const newMessages: ChatMessage[] = [];
  let toolCalls = 0;
  const specs = opts.tools === false ? [] : deps.tools.specs(run.platform, run.allowedToolsets);

  for (let i = 0; i < max; i++) {
    if (run.signal.aborted) throw new RunStoppedError();
    messages = await maybeCompress(deps, run, messages);

    const dbg = await deps.debug.checkpoint(run.runId, 'llm', { iteration: i, messages }, run.signal);
    if (dbg.action === 'abort') throw new RunStoppedError();
    if (dbg.action === 'continue' && Array.isArray(dbg.payload?.messages)) messages = dbg.payload.messages as ChatMessage[];

    const res = await deps.llm.chat({
      principal: run.principal,
      messages,
      model: run.model,
      tools: specs.length ? specs : undefined,
      temperature: opts.temperature,
      onDelta: opts.stream !== false ? run.onDelta : undefined,
      signal: run.signal,
      runId: run.runId,
      sessionId: run.sessionId,
    });
    run.addUsage(res);

    if (!res.toolCalls.length) {
      const final: ChatMessage = { role: 'assistant', content: res.content };
      newMessages.push(final);
      return { output: res.content, newMessages, toolCalls, iterations: i + 1, exhausted: false };
    }

    const assistant: ChatMessage = { role: 'assistant', content: res.content, toolCalls: res.toolCalls };
    messages.push(assistant);
    newMessages.push(assistant);
    if (res.content.trim()) deps.bus.emit({ type: 'thought', runId: run.runId, data: { text: res.content } });

    for (const call of res.toolCalls) {
      if (run.signal.aborted) throw new RunStoppedError();
      const step = await deps.debug.checkpoint(run.runId, 'tool', { tool: call.name, args: call.arguments }, run.signal);
      if (step.action === 'abort') throw new RunStoppedError();
      let toolMsg: ChatMessage;
      if (step.action === 'skip') {
        toolMsg = { role: 'tool', toolCallId: call.id, name: call.name, content: 'Skipped by the operator (debug mode).' };
      } else {
        const args = (step.payload?.args as Record<string, unknown> | undefined) ?? call.arguments;
        const ex = await deps.executor.execute({ ...call, arguments: args }, run.toolCtx, run.security);
        toolCalls++;
        run.toolCalls++;
        run.toolNames.push(call.name);
        if (call.name === 'skill_view' && typeof args.name === 'string') run.skillsUsed.add(args.name);
        toolMsg = { role: 'tool', toolCallId: call.id, name: call.name, content: ex.modelContent, untrusted: ex.modelContent.includes('<untrusted_content') };
      }
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
  }

  // Iteration budget exhausted: ask for the best answer with what we have.
  const closing: ChatMessage = { role: 'user', content: 'You have reached the step limit. Give your best final answer now based on the information gathered, and say what remains undone.' };
  const res = await deps.llm.chat({ principal: run.principal, messages: [...messages, closing], model: run.model, onDelta: run.onDelta, signal: run.signal, runId: run.runId, sessionId: run.sessionId });
  run.addUsage(res);
  newMessages.push({ role: 'assistant', content: res.content });
  return { output: res.content, newMessages, toolCalls, iterations: max, exhausted: true };
}

async function maybeCompress(deps: LoopDeps, run: RunState, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const window = deps.llm.registry.capabilities(run.lastModel ?? run.model ?? deps.config.router.fallback[0] ?? 'mock/echo').contextWindow;
  const { threshold, keepLast } = deps.config.agent.compression;
  if (!needsCompression(messages, window, threshold)) return messages;
  const out = await compressMessages(messages, keepLast, (t) => deps.summarize(run, t));
  if (out.removed) deps.bus.emit({ type: 'context.compressed', runId: run.runId, data: { removed: out.removed } });
  return out.messages;
}
