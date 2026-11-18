/**
 * Offline, deterministic tests for the effective-policy merge (per-agent/personality
 * permission profiles). A profile can only FURTHER RESTRICT the acting user, never escalate.
 */
import { describe, expect, it } from 'vitest';
import { effectivePolicy, PolicyEngine, type UserPolicy, type Principal } from '@mercury/core';

describe('effectivePolicy (user ∩ personality profile)', () => {
  it('returns the user policy unchanged when no profile is given', () => {
    const user: UserPolicy = { allowedTools: ['a', 'b'], maxToolRisk: 'moderate' };
    expect(effectivePolicy(user)).toEqual(user);
  });

  it('a profile can deny a tool the user was allowed (deniedTools union)', () => {
    const eff = effectivePolicy({ allowedTools: ['shell', 'web_search'] }, { deniedTools: ['shell'] });
    expect(eff.deniedTools).toContain('shell');
    expect(eff.allowedTools).toEqual(['shell', 'web_search']); // allow-list unchanged; deny wins at check time
  });

  it('deniedToolsets and deniedModels are the UNION of both sides', () => {
    const eff = effectivePolicy(
      { deniedToolsets: ['shell'], deniedModels: ['gpt-4'] },
      { deniedToolsets: ['browser'], deniedModels: ['claude'] },
    );
    expect(new Set(eff.deniedToolsets)).toEqual(new Set(['shell', 'browser']));
    expect(new Set(eff.deniedModels)).toEqual(new Set(['gpt-4', 'claude']));
  });

  it('maxToolRisk takes the MINIMUM (most restrictive) of the two', () => {
    expect(effectivePolicy({ maxToolRisk: 'dangerous' }, { maxToolRisk: 'safe' }).maxToolRisk).toBe('safe');
    expect(effectivePolicy({ maxToolRisk: 'safe' }, { maxToolRisk: 'dangerous' }).maxToolRisk).toBe('safe');
    expect(effectivePolicy({}, { maxToolRisk: 'moderate' }).maxToolRisk).toBe('moderate');
    expect(effectivePolicy({ maxToolRisk: 'moderate' }, {}).maxToolRisk).toBe('moderate');
  });

  it('allow-lists INTERSECT: only tools permitted by BOTH survive', () => {
    const eff = effectivePolicy({ allowedTools: ['a', 'b', 'c'] }, { allowedTools: ['b', 'c', 'd'] });
    expect(new Set(eff.allowedTools)).toEqual(new Set(['b', 'c']));
  });

  it('a profile cannot widen an allow-list it does not share', () => {
    const eff = effectivePolicy({ allowedTools: ['a'] }, { allowedTools: ['z'] });
    expect(eff.allowedTools).toEqual([]); // nothing in common ⇒ nothing allowed
  });

  it('one-sided allow-list applies as-is', () => {
    expect(effectivePolicy({}, { allowedTools: ['only'] }).allowedTools).toEqual(['only']);
    expect(effectivePolicy({ allowedTools: ['only'] }, {}).allowedTools).toEqual(['only']);
  });

  it('allow-list intersection honours glob patterns (a glob on one side keeps matching names)', () => {
    const eff = effectivePolicy({ allowedTools: ['mcp__github__*'] }, { allowedTools: ['mcp__github__create_issue'] });
    expect(eff.allowedTools).toContain('mcp__github__create_issue');
    // The broad glob is narrowed to only the concrete name the profile also permits.
    expect(eff.allowedTools).not.toContain('mcp__github__delete_repo');
  });
});

describe('PolicyEngine with a personality profile (end-to-end enforcement)', () => {
  const user: Principal = { kind: 'user', userId: 'u1', role: 'user', scopes: ['*'] } as Principal;
  const mkEngine = (userPol: UserPolicy, profiles: Record<string, UserPolicy>) =>
    new PolicyEngine(
      () => userPol,
      (name) => profiles[name],
    );

  it('personality restriction denies a tool the user alone would be allowed', () => {
    const engine = mkEngine({}, { pirate: { deniedToolsets: ['shell'] } });
    const res = { tool: { name: 'bash', toolset: 'shell', risk: 'moderate' as const }, profile: 'pirate' };
    expect(engine.can(user, 'tool.use', res)).toBe(false);
    // Without the profile the same user can use it.
    expect(engine.can(user, 'tool.use', { tool: res.tool })).toBe(true);
  });

  it('a personality cannot ESCALATE: a user-denied tool stays denied even if the profile "allows" it', () => {
    const engine = mkEngine({ deniedTools: ['bash'] }, { pirate: { allowedTools: ['bash'] } });
    const res = { tool: { name: 'bash', toolset: 'shell', risk: 'safe' as const }, profile: 'pirate' };
    expect(engine.can(user, 'tool.use', res)).toBe(false);
  });

  it('profile maxToolRisk caps below the user cap', () => {
    const engine = mkEngine({ maxToolRisk: 'dangerous' }, { safe: { maxToolRisk: 'safe' } });
    const dangerous = { tool: { name: 'rm', toolset: 'shell', risk: 'dangerous' as const }, profile: 'safe' };
    expect(engine.can(user, 'tool.use', dangerous)).toBe(false);
    expect(engine.can(user, 'tool.use', { tool: dangerous.tool })).toBe(true); // user alone may
  });

  it('admins bypass ABAC restrictions entirely', () => {
    const admin: Principal = { kind: 'user', userId: 'a1', role: 'admin', scopes: ['*'] } as Principal;
    const engine = mkEngine({ deniedTools: ['bash'] }, { locked: { deniedToolsets: ['shell'] } });
    expect(engine.can(admin, 'tool.use', { tool: { name: 'bash', toolset: 'shell', risk: 'dangerous' }, profile: 'locked' })).toBe(true);
  });

  it('enforces model.use: a profile can deny a model the user alone could use', () => {
    const engine = mkEngine({}, { cheap: { deniedModels: ['gpt-4o'] } });
    expect(engine.can(user, 'model.use', { model: 'gpt-4o', profile: 'cheap' })).toBe(false);
    expect(engine.can(user, 'model.use', { model: 'gpt-4o' })).toBe(true); // user alone may
    expect(engine.can(user, 'model.use', { model: 'gpt-4o-mini', profile: 'cheap' })).toBe(true); // other model ok
  });

  it('enforces model.use allow-list intersection via a profile', () => {
    const engine = mkEngine({ allowedModels: ['gpt-4o', 'claude-3'] }, { narrow: { allowedModels: ['claude-3'] } });
    expect(engine.can(user, 'model.use', { model: 'gpt-4o', profile: 'narrow' })).toBe(false); // not in intersection
    expect(engine.can(user, 'model.use', { model: 'claude-3', profile: 'narrow' })).toBe(true);
  });

  it('enforces workflow.run allow-lists narrowed by a profile', () => {
    const engine = mkEngine({ allowedWorkflows: ['research', 'triage'] }, { limited: { allowedWorkflows: ['triage'] } });
    expect(engine.can(user, 'workflow.run', { workflow: 'research', profile: 'limited' })).toBe(false);
    expect(engine.can(user, 'workflow.run', { workflow: 'triage', profile: 'limited' })).toBe(true);
    expect(engine.can(user, 'workflow.run', { workflow: 'research' })).toBe(true); // user alone may
  });

  it('enforces API-token scopes independently of ABAC profiles', () => {
    const engine = mkEngine({}, {});
    // A scoped api_client token lacking the "tools" scope cannot use tools...
    const chatOnly: Principal = { kind: 'api_client', userId: 'svc', role: 'user', scopes: ['chat'] } as Principal;
    expect(engine.can(chatOnly, 'tool.use', { tool: { name: 'calc', toolset: 'math', risk: 'safe' } })).toBe(false);
    expect(engine.can(chatOnly, 'chat')).toBe(true);
    // ...while a token with the scope can.
    const withTools: Principal = { kind: 'api_client', userId: 'svc2', role: 'user', scopes: ['tools'] } as Principal;
    expect(withTools.scopes.includes('tools') && engine.can(withTools, 'tool.use', { tool: { name: 'calc', toolset: 'math', risk: 'safe' } })).toBe(true);
  });
});
