/**
 * Memory & skills tools (toolsets "memory" and "skills").
 * - memory: curated MEMORY.md / USER.md (bounded, always in the prompt)
 * - memory_store / memory_recall / memory_forget: long-term semantic + keyword memory
 * - session_search: FTS5 over past conversations with optional LLM summary
 * - skills_list / skill_view / skill_manage / skill_install: progressive-disclosure skills
 */
import { defineTool, installSkills, type AnyTool } from '@mercury/core';
import { arr, bool, num, params, str, strEnum } from '../util.js';

export const memoryTool = defineTool<{ action: 'add' | 'replace' | 'remove' | 'view'; target?: 'memory' | 'user'; content?: string; match?: string }>({
  name: 'memory',
  description:
    'Curated persistent memory that is always in your prompt. target=memory (MEMORY.md: environment facts, conventions, lessons) or user (USER.md: who the user is, preferences). Keep entries short; the files are size-bounded and the oldest entries are dropped.',
  toolset: 'memory',
  risk: 'safe',
  parameters: params(
    { action: strEnum(['add', 'replace', 'remove', 'view'], 'Action'), target: strEnum(['memory', 'user'], 'Which file (default memory)'), content: str('Entry text (add/replace)'), match: str('Text identifying the entry to remove/replace') },
    ['action'],
  ),
  async execute(a, ctx) {
    const curated = ctx.services.memory.curated;
    const uid = ctx.principal.userId;
    const which = a.target ?? 'memory';
    if (a.action === 'view') return curated.read(uid, which) || '(empty)';
    if (a.action === 'remove' || a.action === 'replace') {
      if (!a.match) return { content: 'match is required', isError: true };
      const n = curated.remove(uid, which, a.match);
      if (a.action === 'remove') return `Removed ${n} entr${n === 1 ? 'y' : 'ies'}.`;
    }
    if (!a.content) return { content: 'content is required', isError: true };
    const r = curated.add(uid, which, a.content);
    ctx.emit('memory.write', { target: which, content: a.content });
    return `Saved to ${which === 'user' ? 'USER.md' : 'MEMORY.md'}.${r.dropped.length ? ` Dropped ${r.dropped.length} old entr${r.dropped.length === 1 ? 'y' : 'ies'} to stay within the size limit.` : ''}`;
  },
});

export const memoryStore = defineTool<{ content: string; kind?: 'fact' | 'lesson' | 'preference' | 'note'; tags?: string[]; importance?: number }>({
  name: 'memory_store',
  description: 'Store a fact/lesson/preference/note in long-term memory (searchable later with memory_recall).',
  toolset: 'memory',
  risk: 'safe',
  parameters: params({ content: str('What to remember'), kind: strEnum(['fact', 'lesson', 'preference', 'note'], 'Kind'), tags: arr(str('tag'), 'Tags'), importance: num('0..1') }, ['content']),
  async execute(a, ctx) {
    const f = await ctx.services.memory.remember(ctx.principal.userId, a.content, { kind: a.kind, tags: a.tags, importance: a.importance, source: `tool:${ctx.runId ?? ''}` });
    return `Stored memory ${f.id}.`;
  },
});

export const memoryRecall = defineTool<{ query: string; k?: number }>({
  name: 'memory_recall',
  description: 'Search long-term memory (hybrid keyword + semantic) for relevant facts.',
  toolset: 'memory',
  risk: 'safe',
  parameters: params({ query: str('What to look for'), k: num('Max results (default 5)') }, ['query']),
  async execute(a, ctx) {
    const items = await ctx.services.memory.recall(ctx.principal.userId, a.query, a.k);
    return items.map((m) => `- [${m.id}] ${m.content}${m.kind ? ` (${m.kind})` : ''}`).join('\n') || 'Nothing found.';
  },
});

export const memoryForget = defineTool<{ id_or_text: string }>({
  name: 'memory_forget',
  description: 'Delete long-term memories by id or matching text.',
  toolset: 'memory',
  risk: 'moderate',
  parameters: params({ id_or_text: str('Memory id or text') }, ['id_or_text']),
  async execute(a, ctx) {
    return `Deleted ${await ctx.services.memory.forget(ctx.principal.userId, a.id_or_text)} memories.`;
  },
});

export const sessionSearch = defineTool<{ query: string; limit?: number; summarize?: boolean }>({
  name: 'session_search',
  description: 'Full-text search over your past conversations with this user; summarize=true returns an LLM summary of what was found.',
  toolset: 'memory',
  risk: 'safe',
  parameters: params({ query: str('Search terms'), limit: num('Max hits (default 8)'), summarize: bool('Summarize results') }, ['query']),
  async execute(a, ctx) {
    const r = await ctx.services.memory.searchSessions(ctx.principal.userId, a.query, { limit: a.limit ?? 8, summarize: a.summarize });
    const hits = r.hits.map((h) => `- ${h.createdAt.slice(0, 10)} [${h.title ?? h.sessionId}] ${h.snippet}`).join('\n') || 'No matches.';
    return r.summary ? `Summary: ${r.summary}\n\nMatches:\n${hits}` : hits;
  },
});

export const userProfile = defineTool<{ action: 'view' | 'observe' | 'remove'; text?: string }>({
  name: 'user_profile',
  description: 'View or update the dialectic user model (inferred traits and preferences of the user).',
  toolset: 'memory',
  risk: 'safe',
  parameters: params({ action: strEnum(['view', 'observe', 'remove'], 'Action'), text: str('Observation (observe) or trait text (remove)') }, ['action']),
  async execute(a, ctx) {
    const um = ctx.services.memory.userModel;
    const uid = ctx.principal.userId;
    if (a.action === 'observe' && a.text) um.observe(uid, a.text);
    if (a.action === 'remove' && a.text) um.removeTrait(uid, a.text);
    return um.summary(uid, 20) || 'No profile yet.';
  },
});

export const skillsList = defineTool<{ query?: string }>({
  name: 'skills_list',
  description: 'List available skills (name + description). With query, return the best matching skills.',
  toolset: 'skills',
  risk: 'safe',
  parameters: params({ query: str('Optional search query') }),
  async execute(a, ctx) {
    const skills = a.query ? ctx.services.skills.match(a.query, 8) : ctx.services.skills.list(ctx.platform);
    return skills.map((s) => `- ${s.meta.name}: ${s.meta.description}`).join('\n') || 'No skills installed.';
  },
});

export const skillView = defineTool<{ name: string; file?: string }>({
  name: 'skill_view',
  description: 'Load the full instructions of a skill (or one of its supporting files). Do this before following a skill.',
  toolset: 'skills',
  risk: 'safe',
  parameters: params({ name: str('Skill name'), file: str('Optional supporting file inside the skill folder') }, ['name']),
  async execute(a, ctx) {
    const reg = ctx.services.skills;
    const body = reg.view(a.name, a.file);
    reg.recordUse(a.name, true);
    const files = a.file ? [] : reg.files(a.name).filter((f) => f !== 'SKILL.md');
    return `${body}${files.length ? `\n\nSupporting files: ${files.join(', ')}` : ''}`;
  },
});

export const skillManage = defineTool<{ action: 'create' | 'update'; name: string; description?: string; body?: string; tags?: string[] }>({
  name: 'skill_manage',
  description:
    'Create a new skill or improve an existing one (procedural memory). Write the body as a reusable procedure: When to use, Steps, Pitfalls, Verification. Create skills after solving non-trivial tasks.',
  toolset: 'skills',
  risk: 'safe',
  parameters: params({ action: strEnum(['create', 'update'], 'Action'), name: str('Skill name (lowercase-with-dashes)'), description: str('One sentence: when to use it'), body: str('Markdown instructions'), tags: arr(str('tag'), 'Tags') }, ['action', 'name']),
  async execute(a, ctx) {
    const reg = ctx.services.skills;
    if (a.action === 'create') {
      if (!a.description || !a.body) return { content: 'description and body are required to create a skill', isError: true };
      const s = reg.create({ name: a.name, description: a.description, body: a.body, tags: a.tags, author: ctx.principal.username });
      ctx.emit('skill.created', { name: s.meta.name });
      return `Created skill "${s.meta.name}".`;
    }
    const s = reg.update(a.name, { body: a.body, description: a.description, tags: a.tags });
    ctx.emit('skill.updated', { name: s.meta.name });
    return `Updated skill "${s.meta.name}" (previous version kept).`;
  },
});

export const skillInstall = defineTool<{ source: string; subdir?: string }>({
  name: 'skill_install',
  description: 'Install skills from a local folder or a git URL (admin only).',
  toolset: 'skills',
  risk: 'dangerous',
  sensitive: true,
  needsApproval: (a) => `install skills from ${a.source}`,
  parameters: params({ source: str('Folder path or git URL'), subdir: str('Sub-folder inside the repo') }, ['source']),
  async execute(a, ctx) {
    if (ctx.principal.role !== 'admin') return { content: 'Only admins can install skills.', isError: true };
    const installed = await installSkills(ctx.services.skills, a.source, { subdir: a.subdir });
    return `Installed: ${installed.join(', ') || 'nothing (no SKILL.md found)'}`;
  },
});

export const memoryTools: AnyTool[] = [memoryTool, memoryStore, memoryRecall, memoryForget, sessionSearch, userProfile, skillsList, skillView, skillManage, skillInstall];
