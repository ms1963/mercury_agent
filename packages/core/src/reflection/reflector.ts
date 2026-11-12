/**
 * Reflector — Mercury's closed learning loop (meta-cognitive module, uses Jev when available):
 *
 *  1. Score the answer (decision engine, 5-level rubric).
 *  2. Extract lessons (→ semantic memory, kind "lesson") and user observations
 *     (→ user model) with a structured LLM call.
 *  3. Update skill statistics for skills used in the run; refine a skill when it
 *     was used but the outcome scored poorly (self-improvement, versioned).
 *  4. Autonomously create a new skill after complex, successful tool-heavy tasks
 *     when the decision engine judges the procedure reusable.
 *  5. Persist a reflection record and emit a `reflection` event (Reflections panel).
 *  6. User feedback (/feedback, 👍/👎 in the UI) is fed back as calibration outcomes.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { Judgment } from '../decision/judgment.js';
import type { EventBus } from '../events/bus.js';
import type { LLMService } from '../llm/service.js';
import type { MemoryManager } from '../memory/manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import { errorMessage, extractJson, newId, nowIso, type Principal } from '../types/common.js';

export interface ReflectInput {
  runId: string;
  sessionId: string;
  principal: Principal;
  task: string;
  output: string;
  toolNames: string[];
  skillsUsed: string[];
  transcript?: string;
}

export interface Reflection {
  id: string;
  runId: string;
  userId: string;
  score: number | null;
  verdict: 'good' | 'needs_improvement' | 'unscored';
  lessons: string[];
  observations: string[];
  skillCreated?: string;
  skillsRefined: string[];
  createdAt: string;
  error?: string;
}

export class Reflector {
  constructor(
    private config: MercuryConfig,
    private llm: LLMService,
    private judgment: Judgment,
    private memory: MemoryManager,
    private skills: SkillRegistry,
    private db: Db,
    private bus: EventBus,
  ) {}

  async reflect(input: ReflectInput): Promise<Reflection> {
    const threshold = this.config.decision.thresholds.answerQuality;
    const r: Reflection = { id: newId('ref'), runId: input.runId, userId: input.principal.userId, score: null, verdict: 'unscored', lessons: [], observations: [], skillsRefined: [], createdAt: nowIso() };
    try {
      const s = await this.judgment.scoreAnswer(input.task, input.output, input.runId);
      if (s) {
        r.score = s.fraction;
        r.verdict = s.fraction >= threshold ? 'good' : 'needs_improvement';
      }
      const ok = r.verdict !== 'needs_improvement';

      if (this.config.reflection.lessons) await this.extractLessons(input, r);

      for (const name of input.skillsUsed) {
        this.skills.recordUse(name, ok);
        if (!ok) await this.refineSkill(name, input).then((done) => done && r.skillsRefined.push(name));
      }

      if (this.config.skills.autoCreate && ok && input.toolNames.length >= this.config.skills.minToolCallsForSkill) {
        r.skillCreated = await this.maybeCreateSkill(input);
      }
    } catch (err) {
      r.error = errorMessage(err);
    }
    this.db.run(
      'INSERT INTO reflections (id, run_id, user_id, session_id, score, verdict, lessons, skill, data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      r.id, r.runId, r.userId, input.sessionId, r.score, r.verdict, toJson(r.lessons), r.skillCreated, toJson({ observations: r.observations, skillsRefined: r.skillsRefined, error: r.error, tools: input.toolNames }), r.createdAt,
    );
    this.bus.emit({ type: 'reflection', runId: input.runId, userId: r.userId, data: { ...r } });
    return r;
  }

  private async extractLessons(input: ReflectInput, r: Reflection): Promise<void> {
    const raw = await this.llm.complete(
      input.principal,
      [
        {
          role: 'system',
          content:
            'You reflect on a finished AI-agent task. Extract (a) durable, reusable lessons for future tasks (not task-specific trivia) and (b) observations about the user\'s preferences or context. ' +
            'Return ONLY JSON: {"lessons": ["..."], "userObservations": ["..."]}. Use empty arrays when nothing is worth keeping.',
        },
        { role: 'user', content: `Task: ${input.task.slice(0, 2000)}\nTools used: ${input.toolNames.join(', ') || 'none'}\nAnswer: ${input.output.slice(0, 3000)}\nScore: ${r.score ?? 'n/a'}` },
      ],
      { responseFormat: 'json', kind: 'reflection', runId: input.runId },
    );
    const parsed = extractJson<{ lessons?: unknown[]; userObservations?: unknown[] }>(raw.content) ?? {};
    r.lessons = (parsed.lessons ?? []).filter((x): x is string => typeof x === 'string' && x.length > 5).slice(0, 3);
    r.observations = (parsed.userObservations ?? []).filter((x): x is string => typeof x === 'string' && x.length > 3).slice(0, 3);
    for (const l of r.lessons) await this.memory.remember(input.principal.userId, l, { kind: 'lesson', source: `reflection:${input.runId}` });
    if (this.config.reflection.userModel) for (const o of r.observations) this.memory.userModel.observe(input.principal.userId, o);
  }

  private async refineSkill(name: string, input: ReflectInput): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    const raw = await this.llm.complete(
      input.principal,
      [
        { role: 'system', content: 'A skill (procedure) was followed but the result was poor. Improve the skill instructions. Return ONLY JSON: {"skill": {"description": "...", "body": "...markdown..."}} or {"skill": null} if the skill was not the cause.' },
        { role: 'user', content: `Skill ${name}:\n${skill.body.slice(0, 6000)}\n\nTask: ${input.task.slice(0, 1500)}\nResult: ${input.output.slice(0, 2000)}` },
      ],
      { responseFormat: 'json', kind: 'reflection', runId: input.runId },
    );
    const s = extractJson<{ skill?: { description?: string; body?: string } | null }>(raw.content)?.skill;
    if (!s?.body || s.body.length < 40) return false;
    this.skills.update(name, { body: s.body, description: s.description });
    return true;
  }

  private async maybeCreateSkill(input: ReflectInput): Promise<string | undefined> {
    const p = await this.judgment.shouldCreateSkill({ task: input.task.slice(0, 1500), tools: input.toolNames, answer: input.output.slice(0, 1500) }, input.runId);
    if (p < 0.5) return undefined;
    const raw = await this.llm.complete(
      input.principal,
      [
        { role: 'system', content: 'Turn the procedure the agent just followed into a reusable skill (agentskills.io SKILL.md). Return ONLY JSON: {"skill": {"name": "kebab-case", "description": "what it does and when to use it", "body": "markdown steps, pitfalls, verification"}} or {"skill": null}.' },
        { role: 'user', content: `Task: ${input.task.slice(0, 2000)}\nTool sequence: ${input.toolNames.join(' → ')}\nOutcome: ${input.output.slice(0, 2000)}\n${input.transcript ? `Transcript excerpt:\n${input.transcript.slice(0, 4000)}` : ''}` },
      ],
      { responseFormat: 'json', kind: 'reflection', runId: input.runId },
    );
    const s = extractJson<{ skill?: { name?: string; description?: string; body?: string } | null }>(raw.content)?.skill;
    if (!s?.name || !s.body || !s.description) return undefined;
    if (this.skills.get(s.name)) return undefined;
    return this.skills.create({ name: s.name, description: s.description, body: s.body, author: 'mercury-reflection' }).meta.name;
  }

  /** Explicit user feedback → calibration outcome for this run's decisions + reflection record. */
  feedback(runId: string, positive: boolean): number {
    const decisions = this.db.all<{ id: string; purpose: string }>("SELECT id, purpose FROM decisions WHERE run_id = ? AND purpose IN ('answer_score','routing','pattern_selection')", runId);
    for (const d of decisions) this.judgment.engine.recordOutcome(d.id, positive ? 1 : 0);
    this.db.run('UPDATE reflections SET verdict = ? WHERE run_id = ?', positive ? 'good' : 'needs_improvement', runId);
    return decisions.length;
  }

  list(userId?: string, limit = 50): Array<Record<string, unknown>> {
    const rows = userId
      ? this.db.all<Record<string, unknown>>('SELECT * FROM reflections WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      : this.db.all<Record<string, unknown>>('SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, lessons: fromJson(r.lessons, []), data: fromJson(r.data, {}) }));
  }
}
