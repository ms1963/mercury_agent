import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nextCronRun } from '@mercury/core';

/** Wall-clock hour:minute that an instant falls on inside a given IANA zone. */
function wallTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

describe('scheduler time zone override', () => {
  it('validates IANA time zone names', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('evaluates a daily cron in the target zone, not the host zone', () => {
    // 17:00 wall-clock in Berlin, regardless of which zone the host runs in.
    const winter = nextCronRun('0 17 * * *', new Date('2026-01-10T00:00:00Z'), 'Europe/Berlin');
    expect(wallTime(winter, 'Europe/Berlin')).toBe('17:00');
    // Berlin is CET (+01) in January → 17:00 local is 16:00 UTC.
    expect(winter.toISOString()).toBe('2026-01-10T16:00:00.000Z');

    const summer = nextCronRun('0 17 * * *', new Date('2026-07-10T00:00:00Z'), 'Europe/Berlin');
    expect(wallTime(summer, 'Europe/Berlin')).toBe('17:00');
    // Berlin is CEST (+02) in July → 17:00 local is 15:00 UTC (DST handled).
    expect(summer.toISOString()).toBe('2026-07-10T15:00:00.000Z');
  });

  it('honours a different zone for the same cron expression', () => {
    const ny = nextCronRun('0 17 * * *', new Date('2026-01-10T00:00:00Z'), 'America/New_York');
    expect(wallTime(ny, 'America/New_York')).toBe('17:00');
    // New York is EST (-05) in January → 17:00 local is 22:00 UTC.
    expect(ny.toISOString()).toBe('2026-01-10T22:00:00.000Z');
  });

  it('keeps wall-clock time stable across a DST spring-forward boundary', () => {
    // Europe/Berlin springs forward on 2026-03-29. A 02:30 job does not exist that day;
    // a 09:00 job must still land at 09:00 wall-clock afterwards.
    const afterDst = nextCronRun('0 9 * * *', new Date('2026-03-29T00:00:00Z'), 'Europe/Berlin');
    expect(wallTime(afterDst, 'Europe/Berlin')).toBe('09:00');
  });

  it('matches the host local algorithm when the override equals the host zone', () => {
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const from = new Date('2026-02-15T03:00:00Z');
    const withZone = nextCronRun('30 8 * * *', from, hostZone);
    const noZone = nextCronRun('30 8 * * *', from);
    expect(withZone.toISOString()).toBe(noZone.toISOString());
  });

  it('falls back to the host algorithm for an invalid zone', () => {
    const from = new Date('2026-02-15T03:00:00Z');
    const bad = nextCronRun('30 8 * * *', from, 'Not/AZone');
    const noZone = nextCronRun('30 8 * * *', from);
    expect(bad.toISOString()).toBe(noZone.toISOString());
  });
});
