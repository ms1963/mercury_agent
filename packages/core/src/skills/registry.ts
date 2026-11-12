/**
 * SkillRegistry — procedural memory.
 *
 * Progressive disclosure: only `name + description` of every skill goes into the
 * system prompt (index()). The agent loads the full body with the `skill_view` tool
 * (or the user invokes `/<skill-name>`). Supporting files next to SKILL.md can be
 * read via `skill_view` with a `file` argument.
 *
 * Skills are discovered from (later dirs override earlier ones):
 *   <assets>/skills  (bundled)  →  config.skills.dirs  →  <dataDir>/skills (user/agent-created)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Db } from '../db/db.js';
import { NotFoundError, MercuryError, nowIso } from '../types/common.js';
import { parseSkill, serializeSkill, SKILL_NAME_RE, slugify, type SkillMeta } from './parser.js';

export interface Skill {
  meta: SkillMeta;
  body: string;
  dir: string;
  file: string;
  source: 'bundled' | 'user' | 'external';
  stats: SkillStats;
}

export interface SkillStats {
  uses: number;
  successes: number;
  failures: number;
  lastUsed?: string;
  createdBy?: string;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private watchers: FSWatcher[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private db: Db,
    private dirs: { bundled?: string; extra: string[]; user: string },
  ) {
    mkdirSync(dirs.user, { recursive: true });
    this.reload();
  }

  /** (Re)scan all skill directories. */
  reload(): void {
    this.skills.clear();
    const scan = (dir: string | undefined, source: Skill['source']) => {
      if (!dir || !existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const file = join(dir, entry, 'SKILL.md');
        if (!existsSync(file)) continue;
        try {
          const { meta, body } = parseSkill(readFileSync(file, 'utf8'), entry);
          this.skills.set(meta.name, { meta, body, dir: join(dir, entry), file, source, stats: this.stats(meta.name) });
        } catch {
          /* skip malformed skill files */
        }
      }
    };
    scan(this.dirs.bundled, 'bundled');
    for (const d of this.dirs.extra) scan(d, 'external');
    scan(this.dirs.user, 'user');
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Hot reload when SKILL.md files change on disk. */
  watch(): void {
    for (const d of [this.dirs.bundled, ...this.dirs.extra, this.dirs.user]) {
      if (!d || !existsSync(d)) continue;
      try {
        let timer: NodeJS.Timeout | undefined;
        this.watchers.push(
          watch(d, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => this.reload(), 200);
          }),
        );
      } catch {
        /* recursive watch unsupported → no hot reload */
      }
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  list(platform?: string): Skill[] {
    return [...this.skills.values()]
      .filter((s) => !platform || !s.meta.platforms?.length || s.meta.platforms.includes(platform))
      .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name) ?? this.skills.get(slugify(name));
  }

  /** Read the body or a supporting file of a skill (path-confined to the skill dir). */
  view(name: string, file?: string): string {
    const skill = this.get(name);
    if (!skill) throw new NotFoundError(`Skill "${name}" not found`, 'skills');
    if (!file) return skill.body;
    const target = resolve(skill.dir, file);
    if (relative(skill.dir, target).startsWith('..')) throw new MercuryError('Path escapes the skill directory', 'path_denied', 'skills');
    if (!existsSync(target) || !statSync(target).isFile()) throw new NotFoundError(`File ${file} not found in skill ${name}`, 'skills');
    return readFileSync(target, 'utf8');
  }

  files(name: string): string[] {
    const skill = this.get(name);
    if (!skill) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e !== 'SKILL.md') out.push(relative(skill.dir, p));
      }
    };
    walk(skill.dir);
    return out;
  }

  /** Compact index for the system prompt (progressive disclosure, level 1). */
  index(platform?: string, max = 60): string {
    const items = this.list(platform).slice(0, max);
    if (!items.length) return '';
    return items.map((s) => `- ${s.meta.name}: ${s.meta.description}`).join('\n');
  }

  /** Very small keyword matcher used to suggest skills for a task. */
  match(query: string, k = 3): Skill[] {
    const words = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    return this.list()
      .map((s) => {
        const hay = `${s.meta.name} ${s.meta.description} ${(s.meta.tags ?? []).join(' ')}`.toLowerCase();
        const score = [...words].filter((w) => hay.includes(w)).length;
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.s);
  }

  /** Create a new skill in the user skills dir (used by the agent and by `mercury skills create`). */
  create(input: { name: string; description: string; body: string; tags?: string[]; author?: string; allowedTools?: string[] }): Skill {
    const name = slugify(input.name);
    if (!SKILL_NAME_RE.test(name)) throw new MercuryError(`Invalid skill name "${input.name}"`, 'invalid_skill', 'skills');
    if (this.skills.get(name)?.source === 'user') throw new MercuryError(`Skill "${name}" already exists — use update instead`, 'skill_exists', 'skills');
    const dir = join(this.dirs.user, name);
    mkdirSync(dir, { recursive: true });
    const meta: SkillMeta = { name, description: input.description, tags: input.tags, author: input.author ?? 'mercury', version: 1, allowedTools: input.allowedTools };
    writeFileSync(join(dir, 'SKILL.md'), serializeSkill(meta, input.body));
    this.db.run('INSERT INTO skill_stats (name, created_by) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', name, input.author ?? 'mercury');
    this.reload();
    return this.get(name)!;
  }

  /**
   * Self-improvement: update a skill's body/description, bumping its version and keeping
   * the previous version as SKILL.v<n>.md. Bundled skills are copied to the user dir first.
   */
  update(name: string, patch: { body?: string; description?: string; tags?: string[] }): Skill {
    const skill = this.get(name);
    if (!skill) throw new NotFoundError(`Skill "${name}" not found`, 'skills');
    let dir = skill.dir;
    if (skill.source !== 'user') {
      dir = join(this.dirs.user, skill.meta.name);
      mkdirSync(dir, { recursive: true });
      for (const f of this.files(name)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(join(skill.dir, f), join(dir, f));
      }
    } else {
      copyFileSync(skill.file, join(dir, `SKILL.v${skill.meta.version ?? 1}.md`));
    }
    const meta: SkillMeta = { ...skill.meta, description: patch.description ?? skill.meta.description, tags: patch.tags ?? skill.meta.tags, version: (skill.meta.version ?? 1) + 1, updated: nowIso() };
    writeFileSync(join(dir, 'SKILL.md'), serializeSkill(meta, patch.body ?? skill.body));
    this.reload();
    return this.get(meta.name)!;
  }

  recordUse(name: string, success: boolean): void {
    this.db.run(
      `INSERT INTO skill_stats (name, uses, successes, failures, last_used) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET uses = uses + 1, successes = successes + excluded.successes, failures = failures + excluded.failures, last_used = excluded.last_used`,
      name, success ? 1 : 0, success ? 0 : 1, nowIso(),
    );
    const s = this.skills.get(name);
    if (s) s.stats = this.stats(name);
  }

  stats(name: string): SkillStats {
    const r = this.db.get<{ uses: number; successes: number; failures: number; last_used: string | null; created_by: string | null }>('SELECT * FROM skill_stats WHERE name = ?', name);
    return { uses: r?.uses ?? 0, successes: r?.successes ?? 0, failures: r?.failures ?? 0, lastUsed: r?.last_used ?? undefined, createdBy: r?.created_by ?? undefined };
  }

  get userDir(): string {
    return this.dirs.user;
  }

  /** Skill directory name for display. */
  static dirName(skill: Skill): string {
    return basename(skill.dir);
  }
}
