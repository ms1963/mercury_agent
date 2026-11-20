/**
 * Policy-as-code: declarative rules evaluated BEFORE a sensitive tool action.
 *
 * Rules are config-driven (backward-compatible defaults) so an operator can express guard
 * rails like "no payments over €100 without approval" or "never email external domains"
 * without touching code. Each rule yields an effect — `allow`, `deny` or `approve` — and the
 * executor enforces it (block, or route to human approval) before the action runs.
 *
 * A small built-in rule set (payment cap + external-email) is enabled by default and
 * parameterised from `security.policies`; extra rules may be appended in config or registered
 * programmatically. This builds on the existing permissions/approvals pipeline rather than
 * replacing it.
 */
import type { MercuryConfig } from '../config/schema.js';

export type PolicyEffect = 'allow' | 'deny' | 'approve';

export interface PolicyRule {
  id: string;
  description: string;
  /** Glob on the tool name this rule applies to ('*', 'pay*', 'email_send'). */
  tool: string;
  effect: PolicyEffect;
  /** Numeric-threshold trigger: fires when `args[maxAmountField] > maxAmount`. */
  maxAmountField?: string;
  maxAmount?: number;
  /** Allow-list trigger: fires when `args[field]` matches none of `allowedValues` (globs). */
  field?: string;
  allowedValues?: string[];
  /** Only evaluate the rule when the acting context is tainted by untrusted content. */
  whenTainted?: boolean;
}

export interface PolicyContext {
  /** True when untrusted/tainted content is influencing this action. */
  tainted?: boolean;
}

export interface PolicyDecision {
  decision: PolicyEffect;
  /** The rule that determined a non-allow outcome, if any. */
  rule?: PolicyRule;
  reason: string;
}

/** Case-insensitive glob match (supports `*`). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

/** Extract an email/domain-bearing value from common arg shapes for the external-email rule. */
function emailTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['to', 'recipient', 'recipients', 'email', 'address', 'cc', 'bcc']) {
    const v = args[key];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
  }
  return out;
}

function domainOf(addr: string): string | undefined {
  const m = /@([^@\s>]+)/.exec(addr) ?? /^([a-z0-9.-]+\.[a-z]{2,})$/i.exec(addr.trim());
  return m?.[1]?.toLowerCase();
}

export class PolicyCodeEngine {
  private rules: PolicyRule[] = [];

  constructor(private config: MercuryConfig) {
    this.reload();
  }

  /** Rebuild the active rule set from config (built-ins first, then operator rules). */
  reload(): void {
    const pol = this.config.security.policies;
    const rules: PolicyRule[] = [];
    if (pol.builtins) {
      rules.push({
        id: 'builtin.payment-cap',
        description: `Payments over ${pol.paymentApprovalThreshold} ${pol.currency} require approval`,
        tool: '*pay*',
        effect: 'approve',
        maxAmountField: 'amount',
        maxAmount: pol.paymentApprovalThreshold,
      });
      rules.push({
        id: 'builtin.no-external-email',
        description: pol.allowedEmailDomains.length
          ? `Email may only be sent to: ${pol.allowedEmailDomains.join(', ')}`
          : 'Email to external domains requires approval',
        tool: '*email*',
        effect: 'approve',
        field: '__email_domain__',
        allowedValues: pol.allowedEmailDomains,
      });
    }
    for (const r of pol.rules) {
      rules.push({
        id: r.id,
        description: r.description,
        tool: r.tool,
        effect: r.effect,
        maxAmountField: r.maxAmountField,
        maxAmount: r.maxAmount,
        field: r.field,
        allowedValues: r.allowedValues,
        whenTainted: r.whenTainted,
      });
    }
    this.rules = rules;
  }

  /** Register an extra rule at runtime (appended after existing rules). */
  register(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /** The active rule set (built-ins + config + registered), in evaluation order. */
  list(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate all rules for a tool action. The strictest triggered effect wins
   * (deny > approve > allow). Returns `allow` when nothing triggers.
   */
  evaluate(toolName: string, args: Record<string, unknown> = {}, ctx: PolicyContext = {}): PolicyDecision {
    let worst: PolicyDecision = { decision: 'allow', reason: 'no policy rule triggered' };
    const rank: Record<PolicyEffect, number> = { allow: 0, approve: 1, deny: 2 };
    for (const rule of this.rules) {
      if (!globMatch(rule.tool, toolName)) continue;
      if (rule.whenTainted && !ctx.tainted) continue;
      const trig = this.triggered(rule, args, ctx);
      if (!trig) continue;
      if (rule.effect === 'allow') {
        // An explicit allow short-circuits to allow for this action.
        return { decision: 'allow', rule, reason: trig };
      }
      if (rank[rule.effect] > rank[worst.decision]) worst = { decision: rule.effect, rule, reason: trig };
    }
    return worst;
  }

  /** Whether a rule's condition matches the call. Returns a human reason or null. */
  private triggered(rule: PolicyRule, args: Record<string, unknown>, ctx: PolicyContext): string | null {
    // whenTainted with no other condition: the taint itself is the trigger.
    const hasAmount = rule.maxAmountField !== undefined && rule.maxAmount !== undefined;
    const hasField = rule.field !== undefined;

    if (hasField && rule.field === '__email_domain__') {
      // Built-in external-email: trigger if any target domain is outside the allow-list.
      const targets = emailTargets(args);
      const allowed = rule.allowedValues ?? [];
      const external = targets
        .map(domainOf)
        .filter((d): d is string => !!d)
        .filter((d) => !allowed.some((a) => globMatch(a, d)));
      if (external.length) return `recipient domain(s) not allow-listed: ${[...new Set(external)].join(', ')}`;
      // If there were no parseable targets at all and the tool is an email tool under a
      // strict allow-list, do not trigger (nothing to send to) — treated as non-match.
      return null;
    }

    if (hasAmount) {
      const raw = args[rule.maxAmountField!];
      const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (Number.isFinite(amount) && amount > rule.maxAmount!) return `${rule.maxAmountField}=${amount} exceeds limit ${rule.maxAmount}`;
      return null;
    }

    if (hasField) {
      const raw = args[rule.field!];
      const values = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : typeof raw === 'string' ? [raw] : [];
      const allowed = rule.allowedValues ?? [];
      const bad = values.filter((v) => !allowed.some((a) => globMatch(a, v)));
      if (bad.length) return `${rule.field} value(s) not allowed: ${bad.join(', ')}`;
      return null;
    }

    // No value condition: a tool-glob (optionally tainted) match alone triggers the rule.
    if (rule.whenTainted) return 'tainted context acting on a sensitive tool';
    return `matched tool policy ${rule.id}`;
  }
}
