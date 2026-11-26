/**
 * Scheduler: persistent cron / interval / one-shot jobs. Each job runs a task
 * (a prompt, optionally invoking a skill or workflow) through an injected runner,
 * retries on failure, and delivers the result to a platform target (e.g. Telegram chat).
 * Jobs can be paused, resumed, edited, triggered manually (manual override) and deleted.
 */
import type { Db } from '../db/db.js';
import { fromJson, toJson } from '../db/db.js';
import type { EventBus } from '../events/bus.js';
import { errorMessage, MercuryError, newId, NotFoundError, nowIso } from '../types/common.js';
import { nextCronRun } from './cron.js';
import { parseSchedule, type ScheduleKind } from './natural.js';

export interface Delivery {
  platform: string;
  target: string;
}

export interface Schedule {
  id: string;
  userId: string;
  name: string;
  kind: ScheduleKind;
  spec: string;
  nl?: string;
  task: string;
  delivery?: Delivery;
  status: 'active' | 'paused' | 'done';
  nextRun?: string;
  lastRun?: string;
  maxRetries: number;
  budget?: { maxTokens?: number };
  runCount: number;
  createdAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'ok' | 'error';
  attempt: number;
  output?: string;
  error?: string;
}

export interface CreateScheduleInput {
  name?: string;
  /** Natural language ("every weekday at 9am") or cron expression. */
  when: string;
  task: string;
  delivery?: Delivery;
  maxRetries?: number;
  budget?: { maxTokens?: number };
}

/** Executes the job's task; returns the text to deliver. */
export type ScheduleRunner = (schedule: Schedule, signal: AbortSignal) => Promise<string>;
export type ScheduleDeliver = (delivery: Delivery, text: string, schedule: Schedule) => Promise<void>;

type Row = Record<string, unknown>;

function toSchedule(r: Row): Schedule {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    kind: r.kind as ScheduleKind,
    spec: String(r.spec),
    nl: (r.nl as string) ?? undefined,
    task: String(r.task),
    delivery: fromJson<Delivery | undefined>(r.delivery, undefined) ?? undefined,
    status: r.status as Schedule['status'],
    nextRun: (r.next_run as string) ?? undefined,
    lastRun: (r.last_run as string) ?? undefined,
    maxRetries: Number(r.max_retries),
    budget: fromJson<Schedule['budget']>(r.budget, undefined) ?? undefined,
    runCount: Number(r.run_count),
    createdAt: String(r.created_at),
  };
}

/** Compute the next run time after `from` (undefined = never again). */
export function computeNextRun(kind: ScheduleKind, spec: string, from = new Date(), lastRun?: string, tz?: string): string | undefined {
  if (kind === 'cron') return nextCronRun(spec, from, tz).toISOString();
  if (kind === 'interval') {
    const base = lastRun ? new Date(lastRun).getTime() : from.getTime();
    return new Date(Math.max(base + Number(spec), from.getTime() + 1000)).toISOString();
  }
  return lastRun ? undefined : spec;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = new Map<string, AbortController>();
  deliver?: ScheduleDeliver;

  constructor(
    private db: Db,
    private runner: ScheduleRunner,
    private bus?: EventBus,
    private opts: { tickMs?: number; defaultRetries?: number; timezone?: string } = {},
  ) {
    this.timezone = opts.timezone;
  }

  /** IANA zone used to evaluate cron times; undefined = host computer's local zone. */
  private timezone?: string;

  /** Effective time zone: the configured override, or the host computer's local zone. */
  get effectiveTimezone(): string {
    return this.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Whether a zone override is active (false = follows the host computer). */
  get timezoneOverridden(): boolean {
    return Boolean(this.timezone);
  }

  /**
   * Change the zone used for cron evaluation and recompute every active cron job's next run.
   * Pass undefined/empty to clear the override and follow the host computer's zone.
   * Returns the number of schedules whose next run was recomputed.
   */
  setTimezone(tz?: string): number {
    this.timezone = tz || undefined;
    const rows = this.db.all("SELECT * FROM schedules WHERE status = 'active' AND kind = 'cron'").map(toSchedule);
    for (const s of rows) {
      const next = computeNextRun(s.kind, s.spec, new Date(), undefined, this.timezone);
      this.db.run('UPDATE schedules SET next_run = ? WHERE id = ?', next ?? null, s.id);
    }
    return rows.length;
  }

  setRunner(runner: ScheduleRunner): void {
    this.runner = runner;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.running.values()) c.abort();
  }

  create(userId: string, input: CreateScheduleInput): Schedule {
    const parsed = parseSchedule(input.when);
    if (!parsed) throw new MercuryError(`Could not understand schedule "${input.when}". Try "every weekday at 9am", "every 2 hours", "in 10 minutes" or a cron expression.`, 'bad_schedule', 'scheduler');
    const id = newId('sch');
    const next = computeNextRun(parsed.kind, parsed.spec, new Date(), undefined, this.timezone);
    this.db.run(
      `INSERT INTO schedules (id, user_id, name, kind, spec, nl, task, delivery, status, next_run, max_retries, budget, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      id, userId, input.name ?? input.task.slice(0, 40), parsed.kind, parsed.spec, input.when, input.task,
      input.delivery ? toJson(input.delivery) : null, next, input.maxRetries ?? this.opts.defaultRetries ?? 2,
      input.budget ? toJson(input.budget) : null, nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): Schedule | undefined {
    const r = this.db.get('SELECT * FROM schedules WHERE id = ?', id);
    return r ? toSchedule(r) : undefined;
  }

  private mustGet(id: string, userId?: string): Schedule {
    const s = this.get(id);
    if (!s || (userId && s.userId !== userId)) throw new NotFoundError(`Schedule ${id} not found`);
    return s;
  }

  list(userId?: string): Schedule[] {
    const rows = userId
      ? this.db.all('SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at', userId)
      : this.db.all('SELECT * FROM schedules ORDER BY created_at');
    return rows.map(toSchedule);
  }

  /** Edit a job. `userId` restricts to the owner (omit for admins). */
  update(id: string, patch: Partial<CreateScheduleInput>, userId?: string): Schedule {
    const s = this.mustGet(id, userId);
    let { kind, spec, nl, nextRun } = s;
    if (patch.when) {
      const parsed = parseSchedule(patch.when);
      if (!parsed) throw new MercuryError(`Could not understand schedule "${patch.when}"`, 'bad_schedule', 'scheduler');
      ({ kind, spec } = parsed);
      nl = patch.when;
      nextRun = computeNextRun(kind, spec, new Date(), undefined, this.timezone);
    }
    this.db.run(
      'UPDATE schedules SET name = ?, kind = ?, spec = ?, nl = ?, task = ?, delivery = ?, max_retries = ?, budget = ?, next_run = ? WHERE id = ?',
      patch.name ?? s.name, kind, spec, nl ?? null, patch.task ?? s.task,
      toJson(patch.delivery ?? s.delivery ?? null), patch.maxRetries ?? s.maxRetries, toJson(patch.budget ?? s.budget ?? null), nextRun ?? null, id,
    );
    return this.get(id)!;
  }

  pause(id: string, userId?: string): Schedule {
    this.mustGet(id, userId);
    this.db.run("UPDATE schedules SET status = 'paused' WHERE id = ?", id);
    return this.get(id)!;
  }

  resume(id: string, userId?: string): Schedule {
    const s = this.mustGet(id, userId);
    const next = computeNextRun(s.kind, s.spec, new Date(), s.kind === 'once' ? undefined : s.lastRun, this.timezone);
    this.db.run("UPDATE schedules SET status = 'active', next_run = ? WHERE id = ?", next ?? null, id);
    return this.get(id)!;
  }

  delete(id: string, userId?: string): void {
    this.mustGet(id, userId);
    this.running.get(id)?.abort();
    this.db.run('DELETE FROM schedules WHERE id = ?', id);
  }

  history(id: string, limit = 20): ScheduleRun[] {
    return this.db
      .all('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?', id, limit)
      .map((r) => ({
        id: String(r.id),
        scheduleId: String(r.schedule_id),
        startedAt: String(r.started_at),
        endedAt: (r.ended_at as string) ?? undefined,
        status: r.status as ScheduleRun['status'],
        attempt: Number(r.attempt),
        output: (r.output as string) ?? undefined,
        error: (r.error as string) ?? undefined,
      }));
  }

  /** Run all due jobs. Called by the timer; exposed for tests and manual ticks. */
  async tick(now = new Date()): Promise<number> {
    const due = this.db
      .all("SELECT * FROM schedules WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?", now.toISOString())
      .map(toSchedule)
      .filter((s) => !this.running.has(s.id));
    await Promise.all(due.map((s) => this.execute(s, now)));
    return due.length;
  }

  /** Manual override: run a job immediately regardless of its schedule. */
  async runNow(id: string, userId?: string): Promise<ScheduleRun> {
    const s = this.mustGet(id, userId);
    return this.execute(s, new Date(), false);
  }

  private async execute(s: Schedule, now: Date, advance = true): Promise<ScheduleRun> {
    const controller = new AbortController();
    this.running.set(s.id, controller);
    // Advance next_run first so a crash mid-run doesn't re-fire the job forever.
    if (advance) {
      const next = computeNextRun(s.kind, s.spec, now, now.toISOString(), this.timezone);
      this.db.run(
        'UPDATE schedules SET next_run = ?, status = ? WHERE id = ?',
        next ?? null, next ? s.status : 'done', s.id,
      );
    }
    let run: ScheduleRun | undefined;
    try {
      for (let attempt = 1; attempt <= s.maxRetries + 1; attempt++) {
        run = { id: newId('srun'), scheduleId: s.id, startedAt: nowIso(), status: 'running', attempt };
        this.db.run('INSERT INTO schedule_runs (id, schedule_id, started_at, status, attempt) VALUES (?, ?, ?, ?, ?)', run.id, s.id, run.startedAt, 'running', attempt);
        try {
          const output = await this.runner(s, controller.signal);
          run = { ...run, status: 'ok', output, endedAt: nowIso() };
          if (s.delivery && this.deliver) await this.deliver(s.delivery, output, s);
        } catch (err) {
          run = { ...run, status: 'error', error: errorMessage(err), endedAt: nowIso() };
        }
        this.db.run('UPDATE schedule_runs SET status = ?, ended_at = ?, output = ?, error = ? WHERE id = ?', run.status, run.endedAt ?? null, run.output ?? null, run.error ?? null, run.id);
        if (run.status === 'ok' || controller.signal.aborted) break;
      }
    } finally {
      this.running.delete(s.id);
    }
    this.db.run('UPDATE schedules SET last_run = ?, run_count = run_count + 1 WHERE id = ?', nowIso(), s.id);
    this.bus?.emit({ type: 'schedule.run', userId: s.userId, data: { scheduleId: s.id, name: s.name, status: run!.status, attempt: run!.attempt, error: run!.error } });
    return run!;
  }
}
