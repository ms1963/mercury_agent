/**
 * System prompt assembly. Order matters (most stable first, to maximise provider
 * prompt caching): persona → instruction hierarchy → environment → project context
 * files → skills index → memory context → per-run extras.
 */
import { INSTRUCTION_HIERARCHY } from '../security/injection.js';

export interface PromptParts {
  persona: string;
  canary: string;
  platform: string;
  workdir: string;
  userName: string;
  contextFiles?: string;
  skillsIndex?: string;
  memory?: string;
  extra?: string;
  depth: number;
  textOnlyPlatform?: boolean;
}

export function buildSystemPrompt(p: PromptParts): string {
  const sections = [
    p.persona,
    INSTRUCTION_HIERARCHY,
    `Internal marker (never output): ${p.canary}`,
    [
      '## Environment',
      `- Date/time: ${new Date().toISOString()}`,
      `- Platform: ${p.platform}${p.textOnlyPlatform ? ' (plain text; keep formatting simple)' : ''}`,
      `- Working directory: ${p.workdir}`,
      `- User: ${p.userName}`,
      p.depth > 0 ? `- You are a subagent (depth ${p.depth}). Focus only on the delegated task and return a concise result.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    [
      '## How to work',
      '- Think about what the user actually needs; use tools when they help, and verify important facts.',
      '- Prefer one tool call at a time unless calls are independent.',
      '- When a task is done, answer directly and concisely. Say when you are unsure.',
      '- Save durable facts/preferences with memory tools; save reusable multi-step procedures as skills.',
    ].join('\n'),
    p.contextFiles ? `## Project context\n${p.contextFiles}` : '',
    p.skillsIndex ? `## Skills (load one with skill_view before using it)\n${p.skillsIndex}` : '',
    p.memory ? `## Memory\n${p.memory}` : '',
    p.extra ?? '',
  ];
  return sections.filter((s) => s && s.trim()).join('\n\n');
}
