/**
 * SKILL.md parsing/serialisation (agentskills.io format):
 *
 *   ---
 *   name: pdf-report
 *   description: Turn a folder of notes into a PDF report. Use when ...
 *   license: MIT                 # optional
 *   allowed-tools: [read_file]   # optional
 *   metadata: { version: 1, tags: [docs], author: mercury }
 *   ---
 *   # Markdown instructions ...
 */
import YAML from 'yaml';

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  allowedTools?: string[];
  version?: number;
  tags?: string[];
  platforms?: string[];
  author?: string;
  [key: string]: unknown;
}

export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseSkill(text: string, fallbackName = 'skill'): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const raw = (m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {}) ?? {};
  const body = (m ? m[2]! : text).trim();
  const metadata = (raw.metadata as Record<string, unknown>) ?? {};
  const meta: SkillMeta = {
    ...metadata,
    name: String(raw.name ?? fallbackName),
    description: String(raw.description ?? firstLine(body)),
    license: raw.license as string | undefined,
    allowedTools: (raw['allowed-tools'] ?? raw.allowedTools) as string[] | undefined,
    version: Number(metadata.version ?? raw.version ?? 1),
    tags: (metadata.tags ?? raw.tags ?? []) as string[],
    platforms: (metadata.platforms ?? raw.platforms) as string[] | undefined,
    author: (metadata.author ?? raw.author) as string | undefined,
  };
  return { meta, body };
}

export function serializeSkill(meta: SkillMeta, body: string): string {
  const { name, description, license, allowedTools, version, tags, platforms, author, ...rest } = meta;
  const front: Record<string, unknown> = { name, description };
  if (license) front.license = license;
  if (allowedTools?.length) front['allowed-tools'] = allowedTools;
  const metadata: Record<string, unknown> = { ...rest, version: version ?? 1 };
  if (tags?.length) metadata.tags = tags;
  if (platforms?.length) metadata.platforms = platforms;
  if (author) metadata.author = author;
  front.metadata = metadata;
  return `---\n${YAML.stringify(front).trim()}\n---\n\n${body.trim()}\n`;
}

/** Turn arbitrary text into a valid skill name. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

function firstLine(body: string): string {
  return body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 200) ?? '';
}
