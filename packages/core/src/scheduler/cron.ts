/**
 * Minimal 5-field cron parser: "minute hour day-of-month month day-of-week".
 * Supports `*`, lists (1,2), ranges (1-5), steps (*\/15, 1-10/2) and names
 * (mon-fri, jan-dec). Times are evaluated in the server's local time zone.
 */

interface Field {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DOW_NAMES },
];

export interface CronExpr {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** True when day-of-month / day-of-week were restricted (cron OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseValue(v: string, f: Field): number {
  const named = f.names?.[v.toLowerCase()];
  const n = named ?? Number(v);
  if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`invalid cron value "${v}"`);
  return n;
}

function parseField(text: string, f: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step "${part}"`);
    let lo = f.min;
    let hi = f.max;
    if (range !== '*') {
      const [a, b] = range!.split('-');
      lo = parseValue(a!, f);
      hi = b !== undefined ? parseValue(b, f) : stepText ? f.max : lo;
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
};

export function parseCron(expr: string): CronExpr {
  const text = ALIASES[expr.trim()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression needs 5 fields, got ${parts.length}: "${expr}"`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!));
  const weekdays = sets[4]!;
  if (weekdays.has(7)) weekdays.add(0); // 7 is also Sunday
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c: CronExpr, d: Date): boolean {
  const dom = c.days.has(d.getDate());
  const dow = c.weekdays.has(d.getDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

/** Next matching time strictly after `from` (minute resolution). */
export function nextCronRun(expr: string | CronExpr, from = new Date()): Date {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Scan forward; jump by day/hour when possible to keep this fast. Bounded to ~5 years.
  for (let guard = 0; guard < 500_000; guard++) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`cron expression never matches: ${typeof expr === 'string' ? expr : 'expr'}`);
}
