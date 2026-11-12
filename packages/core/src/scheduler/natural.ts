/**
 * Natural-language schedule parser. Turns phrases like
 *   "every weekday at 9am", "every 2 hours", "daily at 18:30", "in 10 minutes",
 *   "tomorrow at 8", "every monday at 7:15pm", "at 2026-12-01 10:00"
 * into a ScheduleSpec. Anything that already looks like cron is passed through.
 * Deterministic and offline; the agent can still use the LLM to rephrase input.
 */
import { isValidCron } from './cron.js';

export type ScheduleKind = 'cron' | 'interval' | 'once';

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** cron expression, interval in ms (as string), or ISO timestamp. */
  spec: string;
  /** Human-readable description of the parsed schedule. */
  description: string;
}

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const UNIT_MS: Record<string, number> = {
  second: 1000, sec: 1000, s: 1000, minute: 60_000, min: 60_000, m: 60_000,
  hour: 3_600_000, hr: 3_600_000, h: 3_600_000, day: 86_400_000, d: 86_400_000, week: 604_800_000, w: 604_800_000,
};

/** Parse "9", "9am", "9:30pm", "18:30", "noon", "midnight" → [hour, minute]. */
export function parseTimeOfDay(text: string): [number, number] | undefined {
  const t = text.trim().toLowerCase();
  if (t === 'noon') return [12, 0];
  if (t === 'midnight') return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return [h, min];
}

const unitMs = (u: string) => UNIT_MS[u.replace(/s$/, '')] ?? UNIT_MS[u];

/** Returns undefined when the phrase is not understood. */
export function parseSchedule(input: string, now = new Date()): ScheduleSpec | undefined {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (isValidCron(text)) return { kind: 'cron', spec: text, description: `cron "${text}"` };

  // "in 10 minutes"
  let m = /^in (\d+) ?([a-z]+)$/.exec(text);
  if (m && unitMs(m[2]!)) {
    const at = new Date(now.getTime() + Number(m[1]) * unitMs(m[2]!)!);
    return { kind: 'once', spec: at.toISOString(), description: `once at ${at.toISOString()}` };
  }

  // "every 2 hours" / "every 30m" / "every minute"
  m = /^every (\d+)? ?([a-z]+)$/.exec(text);
  if (m && unitMs(m[2]!) && !DAYS[m[2]!] && m[2] !== 'day' && m[2] !== 'weekday') {
    const ms = Number(m[1] ?? 1) * unitMs(m[2]!)!;
    return { kind: 'interval', spec: String(ms), description: `every ${m[1] ?? 1} ${m[2]}` };
  }

  // "[every] (day|weekday|weekend|monday[,friday]) [at TIME]" and "daily/hourly/weekly"
  m = /^(?:every )?(day|daily|weekday|weekdays|weekend|weekends|[a-z, ]+?)(?: at (.+))?$/.exec(text);
  if (m) {
    const [h, min] = m[2] ? parseTimeOfDay(m[2]) ?? [-1, -1] : [9, 0];
    if (h >= 0) {
      const what = m[1]!.trim();
      let dow: string | undefined;
      if (['day', 'daily'].includes(what)) dow = '*';
      else if (what.startsWith('weekday')) dow = '1-5';
      else if (what.startsWith('weekend')) dow = '0,6';
      else {
        const names = what.split(/,| and /).map((s) => s.trim().replace(/s$/, '')).filter(Boolean);
        const nums = names.map((n) => DAYS[n]);
        if (nums.length && nums.every((n) => n !== undefined)) dow = nums.join(',');
      }
      if (dow) {
        const cron = `${min} ${h} * * ${dow}`;
        return { kind: 'cron', spec: cron, description: `${what} at ${pad(h)}:${pad(min)}` };
      }
    }
  }
  if (text === 'hourly') return { kind: 'cron', spec: '0 * * * *', description: 'every hour' };
  if (text === 'weekly') return { kind: 'cron', spec: '0 9 * * 1', description: 'every Monday at 09:00' };

  // "tomorrow at 8" / "today at 17:00" / "at 18:00"
  m = /^(today|tomorrow)?(?: ?at )?(.+)$/.exec(text);
  if (m) {
    const tod = parseTimeOfDay(m[2]!);
    if (tod) {
      const at = new Date(now);
      at.setHours(tod[0], tod[1], 0, 0);
      if (m[1] === 'tomorrow') at.setDate(at.getDate() + 1);
      else if (at <= now) at.setDate(at.getDate() + 1);
      return { kind: 'once', spec: at.toISOString(), description: `once at ${at.toISOString()}` };
    }
  }

  // Absolute date: "at 2026-12-01 10:00" / "2026-12-01T10:00"
  const iso = text.replace(/^at /, '').replace(' ', 'T');
  const date = new Date(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(iso) && !Number.isNaN(date.getTime())) {
    return { kind: 'once', spec: date.toISOString(), description: `once at ${date.toISOString()}` };
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
