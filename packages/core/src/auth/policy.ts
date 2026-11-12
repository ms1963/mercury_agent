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
}

export class PolicyEngine {
  constructor(private policyOf: (userId: string) => UserPolicy = () => ({})) {}

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

    const pol = this.policyOf(p.userId);
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
