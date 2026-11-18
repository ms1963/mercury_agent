/**
 * RBAC + ABAC policy layer.
 *
 * RBAC: roles (`admin`, `user`) and API-token scopes gate *actions*.
 * ABAC: per-user attribute policies restrict *resources* (tools, toolsets, models,
 * workflows) and the maximum tool risk level. Admins bypass ABAC restrictions.
 */
import { PermissionDeniedError, type Principal } from '../types/common.js';

export interface UserPolicy {
  allowedTools?: string[];
  deniedTools?: string[];
  deniedToolsets?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  allowedWorkflows?: string[];
  maxToolRisk?: 'safe' | 'moderate' | 'dangerous';
}

const RISK_RANK = { safe: 0, moderate: 1, dangerous: 2 } as const;
const uniq = (xs: (string[] | undefined)[]): string[] | undefined => {
  const all = xs.flatMap((x) => x ?? []);
  return all.length ? [...new Set(all)] : undefined;
};

/**
 * Compute the EFFECTIVE policy for a user acting under an agent/personality profile.
 *
 * Semantics — most-restrictive / intersection; a profile can only *further restrict*,
 * never escalate beyond what the user is allowed:
 *  - deniedTools / deniedToolsets / deniedModels: UNION (denied by either ⇒ denied).
 *  - maxToolRisk: MINIMUM of the two (undefined = no cap, so a defined cap always wins).
 *  - allowedTools / allowedModels / allowedWorkflows (allow-lists): the effective allow
 *    set is a SUBSET of both. If only one side has a list it applies as-is; if BOTH do,
 *    the result is their intersection (entries each side also permits) — so the profile
 *    can shrink, never widen, the user's allow-list.
 * Passing `profile = undefined` returns the user policy unchanged (backward compatible).
 */
export function effectivePolicy(user: UserPolicy, profile?: UserPolicy): UserPolicy {
  if (!profile) return user;
  const intersectAllow = (u?: string[], p?: string[]): string[] | undefined => {
    if (!u?.length) return p?.length ? [...p] : undefined;
    if (!p?.length) return [...u];
    // Keep only entries each side also permits (plain names → set intersection;
    // globs → kept when matched by the other side). Never wider than either list.
    const keep = new Set<string>();
    for (const a of u) if (p.some((b) => globMatch(b, a) || globMatch(a, b))) keep.add(a);
    for (const b of p) if (u.some((a) => globMatch(a, b) || globMatch(b, a))) keep.add(b);
    return [...keep];
  };
  const risk = (): UserPolicy['maxToolRisk'] => {
    if (!user.maxToolRisk) return profile.maxToolRisk;
    if (!profile.maxToolRisk) return user.maxToolRisk;
    return RISK_RANK[user.maxToolRisk] <= RISK_RANK[profile.maxToolRisk] ? user.maxToolRisk : profile.maxToolRisk;
  };
  const eff: UserPolicy = {
    deniedTools: uniq([user.deniedTools, profile.deniedTools]),
    deniedToolsets: uniq([user.deniedToolsets, profile.deniedToolsets]),
    deniedModels: uniq([user.deniedModels, profile.deniedModels]),
    allowedTools: intersectAllow(user.allowedTools, profile.allowedTools),
    allowedModels: intersectAllow(user.allowedModels, profile.allowedModels),
    allowedWorkflows: intersectAllow(user.allowedWorkflows, profile.allowedWorkflows),
    maxToolRisk: risk(),
  };
  // Drop undefined keys so the shape matches a plain UserPolicy.
  for (const k of Object.keys(eff) as (keyof UserPolicy)[]) if (eff[k] === undefined) delete eff[k];
  return eff;
}

export type Action =
  | 'chat'
  | 'agent.run'
  | 'workflow.run'
  | 'tool.use'
  | 'model.use'
  | 'memory.read'
  | 'memory.write'
  | 'skills.manage'
  | 'schedule.manage'
  | 'tools.manage'
  | 'mcp.access'
  | 'config.manage'
  | 'users.manage'
  | 'budgets.manage'
  | 'gateway.manage'
  | 'audit.read'
  | 'debug';

/** Which token scope grants which action. */
const SCOPE_FOR: Record<Action, string> = {
  chat: 'chat',
  'agent.run': 'agent',
  'workflow.run': 'workflow',
  'tool.use': 'tools',
  'model.use': 'chat',
  'memory.read': 'memory',
  'memory.write': 'memory',
  'skills.manage': 'skills',
  'schedule.manage': 'schedule',
  'tools.manage': 'admin',
  'mcp.access': 'mcp',
  'config.manage': 'admin',
  'users.manage': 'admin',
  'budgets.manage': 'admin',
  'gateway.manage': 'admin',
  'audit.read': 'admin',
  debug: 'agent',
};

const ADMIN_ONLY = new Set<Action>(['tools.manage', 'config.manage', 'users.manage', 'budgets.manage', 'gateway.manage', 'audit.read']);
const RISK_ORDER = { safe: 0, moderate: 1, dangerous: 2 } as const;

/** Glob match supporting `*` wildcards (e.g. "mcp__github__*"). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(value);
}
const anyMatch = (patterns: string[] | undefined, v: string) => (patterns ?? []).some((p) => globMatch(p, v));

export interface ResourceContext {
  tool?: { name: string; toolset: string; risk: 'safe' | 'moderate' | 'dangerous' };
  model?: string;
  workflow?: string;
  /** Agent/personality profile name whose restrictions also apply to this check. */
  profile?: string;
}

export class PolicyEngine {
  /**
   * @param policyOf   resolves the acting user's base policy.
   * @param profileOf  resolves an agent/personality permission profile by name (optional).
   *                   When a check carries `res.profile`, the effective policy is the
   *                   INTERSECTION of the user policy and the profile (see effectivePolicy).
   */
  constructor(
    private policyOf: (userId: string) => UserPolicy = () => ({}),
    private profileOf: (name: string) => UserPolicy | undefined = () => undefined,
  ) {}

  /** The effective policy for a user, optionally narrowed by an agent/personality profile. */
  effectivePolicyFor(userId: string, profile?: string): UserPolicy {
    const base = this.policyOf(userId);
    const prof = profile ? this.profileOf(profile) : undefined;
    return effectivePolicy(base, prof);
  }

  /** Returns a reason string when denied, or null when allowed. */
  check(p: Principal, action: Action, res: ResourceContext = {}): string | null {
    if (p.kind === 'system') return null;
    // Scope check (API tokens). Interactive users carry ['*'].
    const scope = SCOPE_FOR[action];
    if (!p.scopes.includes('*') && !p.scopes.includes(scope) && !(scope === 'chat' && p.scopes.includes('agent'))) {
      return `token lacks scope "${scope}" for ${action}`;
    }
    if (ADMIN_ONLY.has(action) && p.role !== 'admin') return `${action} requires the admin role`;
    if (p.role === 'admin') return null;

    // Effective policy = user policy ∩ agent/personality profile (if any). The profile can
    // only further restrict, never escalate beyond what the user is already allowed.
    const pol = effectivePolicy(this.policyOf(p.userId), res.profile ? this.profileOf(res.profile) : undefined);
    if (res.tool) {
      const { name, toolset, risk } = res.tool;
      if (anyMatch(pol.deniedTools, name)) return `tool "${name}" is denied by your policy`;
      if (anyMatch(pol.deniedToolsets, toolset)) return `toolset "${toolset}" is denied by your policy`;
      if (pol.allowedTools?.length && !anyMatch(pol.allowedTools, name)) return `tool "${name}" is not in your allowed list`;
      if (pol.maxToolRisk && RISK_ORDER[risk] > RISK_ORDER[pol.maxToolRisk]) return `tool "${name}" (${risk}) exceeds your max risk ${pol.maxToolRisk}`;
    }
    if (res.model) {
      if (anyMatch(pol.deniedModels, res.model)) return `model "${res.model}" is denied by your policy`;
      if (pol.allowedModels?.length && !anyMatch(pol.allowedModels, res.model)) return `model "${res.model}" is not in your allowed list`;
    }
    if (res.workflow && pol.allowedWorkflows?.length && !anyMatch(pol.allowedWorkflows, res.workflow)) {
      return `workflow "${res.workflow}" is not in your allowed list`;
    }
    return null;
  }

  can(p: Principal, action: Action, res: ResourceContext = {}): boolean {
    return this.check(p, action, res) === null;
  }

  assert(p: Principal, action: Action, res: ResourceContext = {}): void {
    const reason = this.check(p, action, res);
    if (reason) throw new PermissionDeniedError(`Permission denied: ${reason}`);
  }
}
