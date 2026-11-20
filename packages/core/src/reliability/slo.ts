/**
 * Per-agent SLOs computed from real run history.
 *
 * For each agent (grouped by the model that powered the run) over a trailing window, computes the
 * success rate, the intervention/escalation rate (runs that did not complete cleanly or were
 * flagged for human review by the verification subsystem) and the average cost per task — and
 * compares each against the configured targets. Reads only persisted runs/events/escalations;
 * no mocks.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { fromJson } from '../db/db.js';

export interface AgentSlo {
  agent: string;
  runs: number;
  successRate: number;
  interventionRate: number;
  costPerTask: number;
  escalations: number;
  meetsSuccess: boolean;
  meetsIntervention: boolean;
  meetsCost: boolean;
}

export interface SloReport {
  windowDays: number;
  since: string;
  targets: { targetSuccessRate: number; maxInterventionRate: number; maxCostPerTask: number };
  agents: AgentSlo[];
}

export class SloService {
  constructor(private config: MercuryConfig, private db?: Db) {}

  /** Compute SLOs over the trailing `windowDays` (defaults to the configured window). */
  compute(windowDays = this.config.reliability.slo.windowDays): SloReport {
    const t = this.config.reliability.slo;
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const targets = { targetSuccessRate: t.targetSuccessRate, maxInterventionRate: t.maxInterventionRate, maxCostPerTask: t.maxCostPerTask };
    if (!this.db) return { windowDays, since, targets, agents: [] };

    const runs = this.db.all('SELECT id, model, status FROM runs WHERE started_at >= ?', since);
    // cost per run from run.end events (usage.cost); escalated run ids from the escalations table.
    const costByRun = new Map<string, number>();
    for (const e of this.db.all("SELECT run_id, data FROM events WHERE type = 'run.end' AND ts >= ?", since)) {
      const rid = e.run_id as string | null;
      if (!rid) continue;
      const usage = fromJson<{ usage?: { cost?: number } }>(e.data, {}).usage;
      if (usage && typeof usage.cost === 'number') costByRun.set(rid, usage.cost);
    }
    const escalatedRuns = new Set<string>();
    for (const r of this.db.all('SELECT DISTINCT run_id FROM escalations WHERE run_id IS NOT NULL AND created_at >= ?', since)) escalatedRuns.add(String(r.run_id));

    const groups = new Map<string, { runs: number; ok: number; intervened: number; cost: number; costed: number; escalations: number }>();
    for (const r of runs) {
      const agent = (r.model as string) || 'default';
      const g = groups.get(agent) ?? { runs: 0, ok: 0, intervened: 0, cost: 0, costed: 0, escalations: 0 };
      g.runs++;
      const completed = r.status === 'completed';
      if (completed) g.ok++;
      const escalated = escalatedRuns.has(String(r.id));
      if (!completed || escalated) g.intervened++;
      if (escalated) g.escalations++;
      const c = costByRun.get(String(r.id));
      if (c !== undefined) { g.cost += c; g.costed++; }
      groups.set(agent, g);
    }

    const agents: AgentSlo[] = [...groups.entries()].map(([agent, g]) => {
      const successRate = g.runs ? g.ok / g.runs : 0;
      const interventionRate = g.runs ? g.intervened / g.runs : 0;
      const costPerTask = g.costed ? g.cost / g.costed : 0;
      return {
        agent,
        runs: g.runs,
        successRate: Math.round(successRate * 1e4) / 1e4,
        interventionRate: Math.round(interventionRate * 1e4) / 1e4,
        costPerTask: Math.round(costPerTask * 1e6) / 1e6,
        escalations: g.escalations,
        meetsSuccess: successRate >= t.targetSuccessRate,
        meetsIntervention: interventionRate <= t.maxInterventionRate,
        meetsCost: costPerTask <= t.maxCostPerTask,
      };
    }).sort((a, b) => b.runs - a.runs);

    return { windowDays, since, targets, agents };
  }
}
