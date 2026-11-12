/**
 * Text-based ReAct fallback for models without native tool calling.
 * Tools are described in the system prompt; the model answers with
 *   Thought: ...  Action: <tool>  Action Input: {json}
 * or
 *   Final Answer: ...
 */
import type { ToolCall, ToolSpec } from '../types/messages.js';
import { extractJson, newId } from '../types/common.js';

export function textReactInstructions(tools: ToolSpec[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters.properties ?? {})}`).join('\n');
  return `## Tools (text protocol)
You can use these tools:
${list}

To use a tool, reply EXACTLY in this format and then stop:
Thought: <why>
Action: <tool name>
Action Input: <JSON object with the arguments>

You will receive "Observation: <result>". When you are done, reply:
Final Answer: <answer for the user>`;
}

export interface ParsedReact {
  toolCall?: ToolCall;
  finalAnswer?: string;
  thought?: string;
}

export function parseTextReact(text: string): ParsedReact {
  const thought = /Thought:\s*([\s\S]*?)(?=\n(?:Action|Final Answer):|$)/i.exec(text)?.[1]?.trim();
  const final = /Final Answer:\s*([\s\S]*)$/i.exec(text);
  const action = /Action:\s*([\w.-]+)/i.exec(text);
  if (action && (!final || (final.index ?? 0) > (action.index ?? 0))) {
    const inputRaw = /Action Input:\s*([\s\S]*)$/i.exec(text)?.[1] ?? '{}';
    const args = extractJson<Record<string, unknown>>(inputRaw) ?? (inputRaw.trim() ? { input: inputRaw.trim() } : {});
    return { thought, toolCall: { id: newId('call'), name: action[1]!, arguments: typeof args === 'object' && args ? args : {} } };
  }
  if (final) return { thought, finalAnswer: final[1]!.trim() };
  return { thought, finalAnswer: text.trim() };
}
