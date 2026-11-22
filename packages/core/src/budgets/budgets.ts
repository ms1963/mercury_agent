/**
 * Token/cost budgets and the usage ledger.
 *
 * Budget rules (from config `budgets.rules` and the `budgets` table) apply to a user
 * (or "*"), a model (or "*", glob allowed) and a period (daily/monthly). Checks run
 * before a call (with an estimate) and usage is recorded after the call. Admins can
 * bypass budgets when `budgets.adminBypass` is true or a run sets `budgetOverride`.
 */
import type { BudgetRule, MercuryConfig, ModelProfile } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { globMatch } from '../auth/policy.js';
import { BudgetExceededError, newId, nowIso, type Principal } from '../types/common.js';
import type { TokenUsage } from '../types/messages.js';

export interface StoredBudget extends BudgetRule {
  id: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

export function periodStart(period: 'daily' | 'monthly', now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === 'daily' ? now.getUTCDate() : 1));
  return d.toISOString();
}

export function costOf(profile: Pick<ModelProfile, 'costPer1MInput' | 'costPer1MOutput'> | undefined, usage: TokenUsage): number {
  if (!profile) return 0;
  return (usage.inputTokens * profile.costPer1MInput + usage.outputTokens * profile.costPer1MOutput) / 1_000_000;
}

export class BudgetService {
  constructor(private db: Db, private config: MercuryConfig) {}

  rules(): StoredBudget[] {
    const fromConfig = this.config.budgets.rules.map((r, i) => ({ ...r, id: `config_${i}` }));
    const fromDb = this.db.all<Record<string, unknown>>('SELECT * FROM budgets').map((r) => ({
      id: String(r.id),
      user: String(r.user_id),
      model: String(r.model),
      period: r.period as 'daily' | 'monthly',
      maxTokens: (r.max_tokens as number) ?? undefined,
      maxCost: (r.max_cost as number) ?? undefined,
    }));
    return [...fromConfig, ...fromDb];
  }

  setBudget(rule: BudgetRule): StoredBudget {
    const id = newId('bud');
    this.db.run('INSERT INTO budgets (id, user_id, model, period, max_tokens, max_cost, created_at) VALUES (?,?,?,?,?,?,?)', id, rule.user, rule.model, rule.period, rule.maxTokens, rule.maxCost, nowIso());
    return { ...rule, id };
  }

  deleteBudget(id: string): void {
    this.db.run('DELETE FROM budgets WHERE id = ?', id);
  }

  usage(userId: string | '*', model: string, since: string): UsageSummary {
    const rows = this.db.all<{ model: string; i: number; o: number; c: number; n: number }>(
      `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) c, COUNT(*) n FROM usage WHERE ts >= ? ${userId === '*' ? '' : 'AND user_id = ?'} GROUP BY model`,
      ...(userId === '*' ? [since] : [since, userId]),
    );
    return rows
      .filter((r) => globMatch(model, r.model))
      .reduce((acc, r) => ({ inputTokens: acc.inputTokens + r.i, outputTokens: acc.outputTokens + r.o, cost: acc.cost + r.c, calls: acc.calls + r.n }), { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 });
  }

  /** Throws BudgetExceededError if a call with `estimatedTokens` would exceed any applicable rule. */
  check(principal: Principal, model: string, estimatedTokens = 0, override = false): void {
    if (!this.config.budgets.enabled) return;
    // Auxiliary (system-principal) calls are not covered by user or '*' rules, but an
    // explicit rule for user 'system' caps them, so auxiliary spend can be bounded.
    const isSystem = principal.kind === 'system';
    if (!isSystem && principal.role === 'admin' && (this.config.budgets.adminBypass || override)) return;
    for (const rule of this.rules()) {
      if (isSystem ? rule.user !== 'system' : rule.user !== '*' && rule.user !== principal.userId && rule.user !== principal.username) continue;
      if (!globMatch(rule.model, model)) continue;
      const used = this.usage(principal.userId, rule.model, periodStart(rule.period));
      const tokens = used.inputTokens + used.outputTokens;
      if (rule.maxTokens !== undefined && tokens + estimatedTokens > rule.maxTokens) {
        throw new BudgetExceededError(`${rule.period} token budget exceeded for ${rule.model}: ${tokens}+${estimatedTokens} > ${rule.maxTokens}`);
      }
      if (rule.maxCost !== undefined && used.cost >= rule.maxCost) {
        throw new BudgetExceededError(`${rule.period} cost budget exceeded for ${rule.model}: $${used.cost.toFixed(4)} >= $${rule.maxCost}`);
      }
    }
  }

  record(userId: string, model: string, usage: TokenUsage, cost: number, kind = 'chat', runId?: string): void {
    this.db.run('INSERT INTO usage (user_id, model, input_tokens, output_tokens, cost, kind, run_id, ts) VALUES (?,?,?,?,?,?,?,?)', userId, model, usage.inputTokens, usage.outputTokens, cost, kind, runId, nowIso());
  }

  /** Dashboard data: usage grouped by day and model for a user (or everyone). */
  report(userId: string | '*', days = 30): Array<{ day: string; model: string; tokens: number; cost: number; calls: number }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.all(
      `SELECT substr(ts,1,10) day, model, SUM(input_tokens+output_tokens) tokens, SUM(cost) cost, COUNT(*) calls FROM usage
       WHERE ts >= ? ${userId === '*' ? '' : 'AND user_id = ?'} GROUP BY day, model ORDER BY day`,
      ...(userId === '*' ? [since] : [since, userId]),
    );
  }
}
