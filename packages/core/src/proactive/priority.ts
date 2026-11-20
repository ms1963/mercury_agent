/**
 * Interrupt-timing priority model.
 *
 * Decides how urgent a proactive event is on a 0..1 scale, starting from a rule/base priority and
 * nudging it by signals in the event's kind/title/body (failures and security issues raise it;
 * newsletters and FYIs lower it). The {@link ProactiveService} compares the score against the
 * configured `interruptThreshold` to choose interrupt-now vs defer-to-digest.
 */
export interface PriorityInput {
  kind: string;
  title?: string;
  body?: string;
}

const URGENT = /\b(fail(ed|ure)?|error|down|outage|urgent|critical|security|breach|vulnerab|conflict|overdue|deadline|rejected|blocked|alert|crash)\b/i;
const LOW = /\b(newsletter|digest|promo(tion)?|marketing|fyi|informational|update available|subscrib|notification settings)\b/i;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);

/**
 * Score an event's priority in [0,1]. `base` is the rule/base priority (default 0.5); urgent
 * signals add up to +0.3 and low-value signals subtract up to -0.25.
 */
export function scorePriority(input: PriorityInput, base = 0.5): number {
  const hay = `${input.kind} ${input.title ?? ''} ${input.body ?? ''}`;
  let score = clamp01(base);
  if (URGENT.test(hay)) score += 0.3;
  if (LOW.test(hay)) score -= 0.25;
  // Build/CI failures and security events are always interrupt-worthy.
  if (/\b(build|ci|deploy)\b/i.test(input.kind) && /\b(fail|error|broke|red)\b/i.test(hay)) score += 0.15;
  return Math.round(clamp01(score) * 1e4) / 1e4;
}
