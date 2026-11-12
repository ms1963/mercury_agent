/**
 * Working-memory compression. When the conversation approaches the model's context
 * window (config.agent.compression.threshold), older turns are summarised by the LLM
 * into one "conversation summary" message while the system prompt and the last N
 * messages are kept verbatim. `/compress` forces it.
 */
import type { ChatMessage } from '../types/messages.js';
import { estimateTokens } from '../types/common.js';

export type SummarizeFn = (transcript: string) => Promise<string>;

export function countTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 4, 0);
}

export function needsCompression(messages: ChatMessage[], contextWindow: number, threshold: number): boolean {
  return countTokens(messages) > contextWindow * threshold;
}

/**
 * Compress `messages` (which may start with system messages). Tool-call/result pairs
 * are never split: the kept tail starts at a user message when possible.
 */
export async function compressMessages(messages: ChatMessage[], keepLast: number, summarize: SummarizeFn): Promise<{ messages: ChatMessage[]; removed: number }> {
  const system = messages.filter((m, i) => m.role === 'system' && i < 2 && !m.content.startsWith('[Conversation summary]'));
  const rest = messages.slice(system.length);
  if (rest.length <= keepLast + 1) return { messages, removed: 0 };
  let cut = rest.length - keepLast;
  while (cut > 0 && rest[cut]!.role !== 'user') cut--;
  if (cut <= 0) return { messages, removed: 0 };
  const old = rest.slice(0, cut);
  const transcript = old
    .map((m) => `${m.role.toUpperCase()}${m.name ? `(${m.name})` : ''}: ${m.content.slice(0, 2000)}${m.toolCalls?.length ? ` [called ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''}`)
    .join('\n');
  const summary = await summarize(transcript);
  const summaryMsg: ChatMessage = { role: 'system', content: `[Conversation summary] ${summary}` };
  return { messages: [...system, summaryMsg, ...rest.slice(cut)], removed: old.length };
}
