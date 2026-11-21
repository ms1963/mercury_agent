/**
 * Self-distilling skills — the service that turns winning run traces into reusable, parameterized
 * skills, governs them (review → approve, versioned, auto-retire by success-rate), and reuses an
 * approved matching skill to run proven paths.
 *
 * Integration is opt-in (`skills.distill.enabled`) and degrades gracefully: when disabled or when
 * nothing matches, every entry point is a no-op and a run proceeds exactly as before. All trace
 * reading / distillation is wrapped so it can never break a run (mirrors learning/recorder).
 *
 * The service depends only on the {@link SkillStore} port for persistence; it reads run traces
 * from the same {@link Db} the rest of the system uses (the `runs` + `events` history), exactly as
 * the reliability RunRecorder does. No mocks in product code.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson } from '../db/db.js';
import { safeJsonParse } from '../types/common.js';
import type { EventBus } from '../events/bus.js';
import type { RecordedToolCall } from '../reliability/regression.js';
import { deriveSkillName, generalizeToolCalls, triggerSimilarity } from './generalize.js';
import type { DistilledSkill, SkillStatus, SkillStore } from './ports.js';

/** Outcome recorded against a reused skill (drives stats + auto-retire). */
export interface SkillOutcome {
  success: boolean;
  cost?: number;
  tokens?: number;
}

/** A planner hint built from a matched approved skill (injected into the system prompt). */
export interface SkillPlanHint {
  text: string;
  skill: DistilledSkill;
  similarity: number;
}

interface RunRow {
  id: string;
  input: string | null;
  output: string | null;
  status: string | null;
}

export class DistillerService {
  private off?: () => void;

  constructor(
    private config: MercuryConfig,
    private store: SkillStore,
    private db: Db,
    private bus?: EventBus,
  ) {}

  get enabled(): boolean {
    return this.config.skills.distill.enabled;
  }

  /** Subscribe to run.end so outcomes are recorded / new skills distilled automatically. Idempotent. */
  start(): void {
    if (this.off || !this.bus) return;
    this.off = this.bus.on('run.end', (e) => {
      try {
        this.handleRunEnd(e.runId, e.data as RunEndData | undefined);
      } catch {
        /* distillation must never break a run */
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  // ---- governance / CRUD ------------------------------------------------------------------

  list(status?: SkillStatus): DistilledSkill[] {
    return this.store.list(status);
  }

  get(id: string): DistilledSkill | undefined {
    return this.store.get(id);
  }

  /** Promote a skill to `approved` so the planner may reuse it. */
  approve(id: string): DistilledSkill | undefined {
    const s = this.store.get(id);
    if (!s) return undefined;
    if (s.status !== 'approved') {
      s.status = 'approved';
      this.bus?.emit({ type: 'skill.approved', data: { id: s.id, name: s.name, version: s.version } });
    }
    return this.store.save(s);
  }

  /** Demote a skill to `retired` so it is no longer matched. */
  retire(id: string, reason = 'manual'): DistilledSkill | undefined {
    const s = this.store.get(id);
    if (!s) return undefined;
    if (s.status !== 'retired') {
      s.status = 'retired';
      this.bus?.emit({ type: 'skill.retired', data: { id: s.id, name: s.name, version: s.version, reason } });
    }
    return this.store.save(s);
  }

  // ---- matching / reuse -------------------------------------------------------------------

  /** Best approved skill whose trigger matches the task above the configured threshold, else undefined. */
  match(task: string): SkillPlanHint | undefined {
    if (!this.enabled || !task.trim()) return undefined;
    const min = this.config.skills.distill.matchMinSimilarity;
    let best: { skill: DistilledSkill; sim: number } | undefined;
    for (const skill of this.store.list('approved')) {
      const sim = triggerSimilarity(task, skill.trigger);
      if (sim >= min && (!best || sim > best.sim)) best = { skill, sim };
    }
    if (!best) return undefined;
    return { text: this.renderHint(best.skill, best.sim), skill: best.skill, similarity: best.sim };
  }

  /** Planner hint for the agent system prompt (empty/undefined when nothing matches). */
  planHintFor(task: string): SkillPlanHint | undefined {
    return this.match(task);
  }

  private renderHint(skill: DistilledSkill, sim: number): string {
    const steps = skill.steps
      .map((s, i) => {
        const args = Object.keys(s.args).length ? ` ${JSON.stringify(s.args)}` : '';
        return `  ${i + 1}. ${s.tool}${args}`;
      })
      .join('\n');
    const params = skill.params.length
      ? `\nParameters: ${skill.params.map((p) => `${p.name}:${p.type}`).join(', ')}`
      : '';
    const rate = skill.stats.uses > 0 ? ` (proven over ${skill.stats.uses} use(s), ${Math.round(skill.stats.successRate * 100)}% success)` : '';
    return (
      `## Proven skill: ${skill.name}${rate}\n` +
      `A past run handled a very similar request (match ${Math.round(sim * 100)}%) with this tool sequence. ` +
      `Prefer it unless the request clearly differs:\n${steps}${params}`
    );
  }

  /** Record the outcome of reusing a skill; updates stats and auto-retires if it degrades. */
  recordOutcome(skillId: string, outcome: SkillOutcome): DistilledSkill | undefined {
    const s = this.store.get(skillId);
    if (!s) return undefined;
    const prevUses = s.stats.uses;
    const prevCostSum = s.stats.avgCost * prevUses;
    const prevTokensSum = s.stats.avgTokens * prevUses;
    const uses = prevUses + 1;
    const successes = s.stats.successes + (outcome.success ? 1 : 0);
    const failures = s.stats.failures + (outcome.success ? 0 : 1);
    const costSum = prevCostSum + (outcome.cost ?? 0);
    const tokensSum = prevTokensSum + (outcome.tokens ?? 0);
    const denom = successes + failures;
    s.stats = {
      uses,
      successes,
      failures,
      successRate: denom > 0 ? Math.round((successes / denom) * 1e4) / 1e4 : 0,
      avgCost: uses > 0 ? Math.round((costSum / uses) * 1e6) / 1e6 : 0,
      avgTokens: uses > 0 ? Math.round(tokensSum / uses) : 0,
      lastUsed: new Date().toISOString(),
    };
    const { minRunsBeforeRetire, retireBelowSuccessRate } = this.config.skills.distill;
    const saved = this.store.save(s);
    if (saved.status === 'approved' && saved.stats.uses >= minRunsBeforeRetire && saved.stats.successRate < retireBelowSuccessRate) {
      return this.retire(saved.id, 'success-rate-below-threshold');
    }
    return saved;
  }

  // ---- distillation -----------------------------------------------------------------------

  /**
   * Distil (or version) a skill from a run's trace. Returns the created/updated skill, or
   * undefined when the run is ineligible (too few tool calls, missing, disabled). Safe to call
   * repeatedly: a trace matching an existing skill's intent versions it rather than duplicating.
   */
  distillFromRun(runId: string, opts?: { force?: boolean }): DistilledSkill | undefined {
    if (!this.enabled && !opts?.force) return undefined;
    const run = this.db.get<RunRow>('SELECT id, input, output, status FROM runs WHERE id = ?', runId);
    if (!run) return undefined;
    const trigger = (run.input ?? '').trim();
    if (!trigger) return undefined;

    const toolEvents = this.db.all<{ data: unknown }>(
      "SELECT data FROM events WHERE run_id = ? AND type = 'tool.call' ORDER BY ts, rowid",
      runId,
    );
    const calls: RecordedToolCall[] = toolEvents.map((r) => {
      const d = fromJson<{ name?: string; args?: unknown }>(r.data, {});
      // tool.call events persist args as a (redacted) JSON string; parse it back so concrete
      // values can be generalized into parameter slots (falls back to {} when unparseable).
      const args = typeof d.args === 'string' ? safeJsonParse<Record<string, unknown>>(d.args) ?? {} : d.args;
      return { name: String(d.name ?? ''), args };
    });
    if (calls.length < this.config.skills.distill.minToolCalls) return undefined;

    const { steps, params } = generalizeToolCalls(calls);
    if (!steps.length) return undefined;

    // Dedup / versioning: a trace whose intent is close enough to an existing skill versions it.
    const dedupMin = this.config.skills.distill.dedupMinSimilarity;
    let dupe: { skill: DistilledSkill; sim: number } | undefined;
    for (const existing of this.store.list()) {
      if (existing.status === 'retired') continue;
      const sim = triggerSimilarity(trigger, existing.trigger);
      if (sim >= dedupMin && (!dupe || sim > dupe.sim)) dupe = { skill: existing, sim };
    }

    let result: DistilledSkill;
    if (dupe) {
      const s = dupe.skill;
      s.version += 1;
      s.steps = steps;
      s.params = params;
      s.trigger = trigger;
      s.sourceRuns = [runId, ...s.sourceRuns.filter((r) => r !== runId)].slice(0, 20);
      result = this.store.save(s);
      this.bus?.emit({ type: 'skill.versioned', runId, data: { id: s.id, name: s.name, version: s.version } });
    } else {
      const toolNames = steps.map((s) => s.tool).filter(Boolean);
      const name = this.uniqueName(deriveSkillName(trigger, toolNames));
      const status: SkillStatus = this.config.skills.distill.autoApprove ? 'approved' : 'pending';
      result = this.store.insert({ name, trigger, params, steps, status, sourceRun: runId });
      this.bus?.emit({ type: 'skill.distilled', runId, data: { id: result.id, name: result.name, status } });
    }

    try {
      this.store.pruneRetired(this.config.skills.distill.maxSkills);
    } catch {
      /* pruning is best-effort */
    }
    return result;
  }

  /** Distil from a run on positive (👍) feedback, regardless of its original completion path. */
  onFeedback(runId: string, positive: boolean): DistilledSkill | undefined {
    if (!this.enabled || !positive) return undefined;
    try {
      return this.distillFromRun(runId);
    } catch {
      return undefined;
    }
  }

  private uniqueName(base: string): string {
    if (!this.store.getByName(base)) return base;
    let i = 2;
    while (this.store.getByName(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  // ---- run.end handling -------------------------------------------------------------------

  private handleRunEnd(runId: string | undefined, data: RunEndData | undefined): void {
    if (!this.enabled || !runId) return;
    const run = this.db.get<RunRow>('SELECT id, input, output, status FROM runs WHERE id = ?', runId);
    const input = (run?.input ?? '').trim();
    if (!input) return;
    const completed = (data?.status ?? run?.status) === 'completed';
    const cost = data?.usage?.cost ?? 0;
    const tokens = (data?.usage?.inputTokens ?? 0) + (data?.usage?.outputTokens ?? 0);

    // If this run reused a proven path, attribute the outcome to the matched skill (stats +
    // auto-retire). Otherwise, a successful novel run is a candidate to distil a new skill.
    const matched = this.match(input);
    if (matched) {
      this.recordOutcome(matched.skill.id, { success: completed, cost, tokens });
      return;
    }
    if (completed) this.distillFromRun(runId);
  }
}

interface RunEndData {
  status?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
}
