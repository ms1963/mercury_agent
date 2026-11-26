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

function dayMatchesVals(c: CronExpr, dom: number, dow: number): boolean {
  const domM = c.days.has(dom);
  const dowM = c.weekdays.has(dow);
  if (c.domRestricted && c.dowRestricted) return domM || dowM;
  if (c.domRestricted) return domM;
  if (c.dowRestricted) return dowM;
  return true;
}

function dayMatches(c: CronExpr, d: Date): boolean {
  return dayMatchesVals(c, d.getDate(), d.getDay());
}

/** True when `tz` is a time zone IANA name the runtime understands (e.g. "Europe/Berlin"). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of an instant as seen in a given IANA time zone. */
function zonedParts(instant: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

/** Offset (ms) of the zone at the given instant: zoned-wall-interpreted-as-UTC minus the instant. */
function zoneOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/** Convert a wall clock in `tz` to the matching UTC instant (DST-safe; minute resolution). */
function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let off = zoneOffsetMs(new Date(guess), tz);
  const inst = guess - off;
  off = zoneOffsetMs(new Date(inst), tz); // refine across a DST boundary
  return new Date(guess - off);
}

const daysInMonth = (y: number, mo: number): number => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dowOf = (y: number, mo: number, d: number): number => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** Next matching time strictly after `from`, evaluated in wall-clock of `tz` (DST-safe). */
function nextCronRunZoned(c: CronExpr, from: Date, tz: string): Date {
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  let { y, mo, d, h, mi } = zonedParts(start, tz);
  const bumpDay = () => {
    d++;
    h = 0;
    mi = 0;
    if (d > daysInMonth(y, mo)) {
      d = 1;
      mo++;
      if (mo > 12) {
        mo = 1;
        y++;
      }
    }
  };
  for (let guard = 0; guard < 500_000; guard++) {
    if (!c.months.has(mo)) {
      mo++;
      d = 1;
      h = 0;
      mi = 0;
      if (mo > 12) {
        mo = 1;
        y++;
      }
      continue;
    }
    if (!dayMatchesVals(c, d, dowOf(y, mo, d))) {
      bumpDay();
      continue;
    }
    if (!c.hours.has(h)) {
      h++;
      mi = 0;
      if (h > 23) bumpDay();
      continue;
    }
    if (!c.minutes.has(mi)) {
      mi++;
      if (mi > 59) {
        mi = 0;
        h++;
        if (h > 23) bumpDay();
      }
      continue;
    }
    return zonedWallToUtc(y, mo, d, h, mi, tz);
  }
  throw new Error('cron expression never matches');
}

/**
 * Next matching time strictly after `from` (minute resolution).
 * When `tz` is a valid IANA zone, the expression is evaluated in that zone's wall clock;
 * otherwise it is evaluated in the process's local time zone (the host computer's zone).
 */
export function nextCronRun(expr: string | CronExpr, from = new Date(), tz?: string): Date {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (tz && isValidTimeZone(tz)) return nextCronRunZoned(c, from, tz);
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
