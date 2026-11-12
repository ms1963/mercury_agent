/**
 * Usage and insights reports (`/usage`, `/insights`, cost dashboards in the web UI).
 */
import type { Db } from '../db/db.js';

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number; calls: number }>;
}

export function sessionUsage(db: Db, sessionId: string): UsageReport {
  const rows = db.all<{ model: string; i: number; o: number; c: number; n: number }>(
    'SELECT u.model, SUM(u.input_tokens) i, SUM(u.output_tokens) o, SUM(u.cost) c, COUNT(*) n FROM usage u JOIN runs r ON r.id = u.run_id WHERE r.session_id = ? GROUP BY u.model',
    sessionId,
  );
  return summarize(rows);
}

export function userUsage(db: Db, userId: string | undefined, sinceIso: string): UsageReport {
  const rows = userId
    ? db.all<{ model: string; i: number; o: number; c: number; n: number }>('SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) c, COUNT(*) n FROM usage WHERE user_id = ? AND ts >= ? GROUP BY model', userId, sinceIso)
    : db.all<{ model: string; i: number; o: number; c: number; n: number }>('SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost) c, COUNT(*) n FROM usage WHERE ts >= ? GROUP BY model', sinceIso);
  return summarize(rows);
}

function summarize(rows: Array<{ model: string; i: number; o: number; c: number; n: number }>): UsageReport {
  const byModel = rows.map((r) => ({ model: r.model, inputTokens: r.i ?? 0, outputTokens: r.o ?? 0, cost: r.c ?? 0, calls: r.n }));
  return {
    inputTokens: byModel.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: byModel.reduce((s, r) => s + r.outputTokens, 0),
    cost: byModel.reduce((s, r) => s + r.cost, 0),
    calls: byModel.reduce((s, r) => s + r.calls, 0),
    byModel,
  };
}

export interface Insights {
  days: number;
  sessions: number;
  runs: number;
  failedRuns: number;
  usage: UsageReport;
  topTools: Array<{ tool: string; calls: number }>;
  patterns: Array<{ pattern: string; runs: number }>;
  avgScore: number | null;
  skillsCreated: number;
  dailyCost: Array<{ day: string; cost: number; tokens: number }>;
}

export function insights(db: Db, userId: string | undefined, days = 30): Insights {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const u = userId ? 'AND user_id = ?' : '';
  const p = (...a: (string | number)[]) => (userId ? [...a, userId] : a);
  const one = <T>(sql: string, ...a: (string | number)[]) => db.get<T>(sql, ...a);
  const sessions = one<{ n: number }>(`SELECT COUNT(*) n FROM sessions WHERE updated_at >= ? ${u}`, ...p(since))?.n ?? 0;
  const runs = one<{ n: number; f: number }>(`SELECT COUNT(*) n, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) f FROM runs WHERE started_at >= ? ${u}`, ...p(since));
  const topTools = db
    .all<{ tool: string; calls: number }>(`SELECT json_extract(data, '$.name') tool, COUNT(*) calls FROM events WHERE type = 'tool.result' AND ts >= ? ${u} GROUP BY tool ORDER BY calls DESC LIMIT 10`, ...p(since))
    .filter((t) => t.tool);
  const patterns = db.all<{ pattern: string; runs: number }>(`SELECT pattern, COUNT(*) runs FROM runs WHERE started_at >= ? AND pattern IS NOT NULL ${u} GROUP BY pattern ORDER BY runs DESC`, ...p(since));
  const avg = one<{ a: number | null }>(`SELECT AVG(score) a FROM reflections WHERE created_at >= ? AND score IS NOT NULL ${u}`, ...p(since))?.a ?? null;
  const skillsCreated = one<{ n: number }>(`SELECT COUNT(*) n FROM reflections WHERE skill IS NOT NULL AND created_at >= ? ${u}`, ...p(since))?.n ?? 0;
  const dailyCost = db.all<{ day: string; cost: number; tokens: number }>(
    `SELECT substr(ts, 1, 10) day, SUM(cost) cost, SUM(input_tokens + output_tokens) tokens FROM usage WHERE ts >= ? ${u} GROUP BY day ORDER BY day`,
    ...p(since),
  );
  return { days, sessions, runs: runs?.n ?? 0, failedRuns: runs?.f ?? 0, usage: userUsage(db, userId, since), topTools, patterns, avgScore: avg, skillsCreated, dailyCost };
}

export function formatUsage(r: UsageReport): string {
  const lines = [`Tokens: ${r.inputTokens} in / ${r.outputTokens} out · cost $${r.cost.toFixed(4)} · ${r.calls} LLM call(s)`];
  for (const m of r.byModel) lines.push(`  ${m.model}: ${m.inputTokens}/${m.outputTokens} tokens, $${m.cost.toFixed(4)}`);
  return lines.join('\n');
}

export function formatInsights(i: Insights): string {
  return [
    `Last ${i.days} days: ${i.sessions} session(s), ${i.runs} run(s) (${i.failedRuns} failed)`,
    formatUsage(i.usage),
    `Top tools: ${i.topTools.map((t) => `${t.tool}×${t.calls}`).join(', ') || 'none'}`,
    `Patterns: ${i.patterns.map((p) => `${p.pattern}×${p.runs}`).join(', ') || 'none'}`,
    `Average answer score: ${i.avgScore === null ? 'n/a' : i.avgScore.toFixed(2)} · skills created: ${i.skillsCreated}`,
  ].join('\n');
}
