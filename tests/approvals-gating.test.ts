/**
 * Normal (behavioural) tests for the approval gating fast-path and admin-predetermined rules.
 *
 * These exercise ToolExecutor.approve() end-to-end through execute():
 *  - manual mode WITH an interactive handler still waits for and honours the human decision;
 *  - an UNANSWERABLE request (no handler, non-API-answerable platform) resolves fast instead of
 *    dead-waiting the timeout, and NEVER auto-ALLOWS a risky/host/untrusted call;
 *  - auto/smart modes behave as before;
 *  - the unattended knob (gate|deny|wait) is honoured;
 *  - admin-predetermined approval rules let an admin pre-decide non-admin tool approvals.
 *
 * All deterministic: the smart gate is a local stub (no network LLM).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ConfigSchema,
  EventBus,
  PolicyEngine,
  ToolRegistry,
  ToolExecutor,
  ApprovalService,
  defineTool,
  type Judgment,
  type ToolContext,
  type ToolServices,
  type RunSecurityState,
  type Principal,
  type MercuryConfig,
} from '@mercury/core';

// ---- helpers --------------------------------------------------------------------------------

const principal = (role: 'admin' | 'user' = 'user'): Principal => ({
  userId: role === 'admin' ? 'admin-1' : 'user-1',
  username: role,
  role,
  kind: 'user',
  scopes: ['*'],
});

/** A gate stub whose verdict and call-count we control. */
function gateStub(verdict: { approve: boolean; probability?: number }) {
  const calls: Array<{ tool: string }> = [];
  const judgment = {
    gateToolCall: vi.fn(async (input: { tool: string }) => {
      calls.push({ tool: input.tool });
      return { approve: verdict.approve, probability: verdict.probability ?? (verdict.approve ? 0.9 : 0.1) };
    }),
  } as unknown as Judgment;
  return { judgment, calls };
}

function makeExecutor(cfg: MercuryConfig, judgment?: Judgment) {
  const bus = new EventBus();
  const registry = new ToolRegistry(cfg);
  const policy = new PolicyEngine();
  const executor = new ToolExecutor(cfg, registry, policy, bus, judgment, undefined, undefined);
  return { bus, registry, policy, executor };
}

/** A dangerous tool (always triggers the approval gate) that records whether it actually ran. */
function dangerTool(ran: { value: boolean }) {
  return defineTool({
    name: 'danger_do',
    description: 'test dangerous tool',
    toolset: 'test',
    risk: 'dangerous',
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    async execute() {
      ran.value = true;
      return { content: 'did it' };
    },
  });
}

/** A moderate tool that requires per-call approval but is NOT dangerous/host. */
function moderateApprovalTool(ran: { value: boolean }, sensitive = false) {
  return defineTool({
    name: 'mod_act',
    description: 'test moderate tool needing approval',
    toolset: 'test',
    risk: 'moderate',
    sensitive,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    needsApproval: () => 'needs approval for test',
    async execute() {
      ran.value = true;
      return { content: 'ok' };
    },
  });
}

function ctxFor(opts: { platform: string; approvals: ApprovalService; role?: 'admin' | 'user' }): ToolContext {
  return {
    principal: principal(opts.role ?? 'user'),
    runId: 'run-' + Math.random().toString(36).slice(2),
    platform: opts.platform,
    workdir: '/tmp',
    depth: 0,
    services: {} as unknown as ToolServices,
    emit: () => {},
    requestApproval: (req) => opts.approvals.request(req, { userId: (opts.role ?? 'user') === 'admin' ? 'admin-1' : 'user-1', platform: opts.platform }),
    approvalAnswerable: () => opts.approvals.isAnswerable(opts.platform),
  };
}

const freshState = (untrusted = false): RunSecurityState => ({ untrustedSeen: untrusted, userRequest: 'please do the thing' });
const call = (name: string, args: Record<string, unknown> = { x: '1' }) => ({ id: 'c1', name, arguments: args });

// ---- manual mode WITH a handler (real human-in-the-loop preserved) ---------------------------

describe('manual mode with an interactive handler', () => {
  it('honours a human APPROVE', async () => {
    const cfg = ConfigSchema.parse({});
    const { executor, registry, bus } = makeExecutor(cfg);
    const approvals = new ApprovalService(bus);
    approvals.setHandler('cli', async () => true); // human approves
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'cli', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(true);
    expect(ran.value).toBe(true);
  });

  it('honours a human DENY (tool never runs)', async () => {
    const cfg = ConfigSchema.parse({});
    const { executor, registry, bus } = makeExecutor(cfg);
    const approvals = new ApprovalService(bus);
    approvals.setHandler('cli', async () => false); // human denies
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'cli', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(false);
    expect(ran.value).toBe(false);
  });
});

// ---- unanswerable request (no handler) -------------------------------------------------------

describe('unanswerable request (manual mode, no handler, non-API platform)', () => {
  it('DENIES a dangerous call fast via unattended=gate (never auto-allowed)', async () => {
    const cfg = ConfigSchema.parse({}); // mode manual, unattended gate (defaults)
    const { judgment } = gateStub({ approve: true }); // even a permissive gate must NOT allow a dangerous unanswerable call
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const approvals = new ApprovalService(bus); // no handler for 'web'
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(false);
    expect(ran.value).toBe(false);
    expect(res.result.content).toMatch(/no approver/i);
  });

  it('lets the gate decide a NON-dangerous approval-required call (approve)', async () => {
    const cfg = ConfigSchema.parse({});
    const { judgment, calls } = gateStub({ approve: true });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const approvals = new ApprovalService(bus);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran));
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState());
    expect(res.ok).toBe(true);
    expect(ran.value).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('denies a NON-dangerous approval-required call when the gate rejects', async () => {
    const cfg = ConfigSchema.parse({});
    const { judgment } = gateStub({ approve: false });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState());
    expect(res.ok).toBe(false);
    expect(ran.value).toBe(false);
  });

  it('NEVER gate-allows an untrusted-derived sensitive call (injection safety net)', async () => {
    const cfg = ConfigSchema.parse({});
    const { judgment } = gateStub({ approve: true }); // permissive gate
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran, /* sensitive */ true));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState(/* untrusted */ true));
    expect(res.ok).toBe(false);
    expect(ran.value).toBe(false);
  });

  it('unattended=deny denies every unanswerable gated call immediately', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { unattended: 'deny' } } });
    const { judgment } = gateStub({ approve: true });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState());
    expect(res.ok).toBe(false);
    expect(res.result.content).toMatch(/unattended=deny/);
  });
});

// ---- API-answerable platform still routes to the human wait ----------------------------------

describe('apiAnswerablePlatforms', () => {
  it('treats a declared platform as answerable and honours the API resolution', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { apiAnswerablePlatforms: ['web'] } } });
    const { executor, registry, bus } = makeExecutor(cfg);
    const approvals = new ApprovalService(bus, { apiAnswerablePlatforms: ['web'] });
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'web', approvals });
    // Resolve via the API shortly after the request is registered.
    const p = executor.execute(call('danger_do'), ctx, freshState());
    await vi.waitFor(() => expect(approvals.list().length).toBe(1));
    const pending = approvals.list()[0];
    approvals.resolveAs(pending.id, true, { userId: 'admin-1', role: 'admin' });
    const res = await p;
    expect(res.ok).toBe(true);
    expect(ran.value).toBe(true);
  });
});

// ---- auto / smart modes unchanged ------------------------------------------------------------

describe('auto and smart modes', () => {
  it('auto mode auto-approves a non-dangerous approval-required call without the gate', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'auto' } } });
    const { judgment, calls } = gateStub({ approve: false });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState());
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(0); // auto never consulted the gate for a safe, non-tainted call
  });

  it('auto mode consults the gate for an untrusted-derived sensitive call', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'auto' } } });
    const { judgment, calls } = gateStub({ approve: false });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran, true));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState(true));
    expect(res.ok).toBe(false); // gate rejected
    expect(calls.length).toBe(1);
  });

  it('smart mode approves a non-dangerous call when the gate approves', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'smart' } } });
    const { judgment } = gateStub({ approve: true });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState());
    expect(res.ok).toBe(true);
  });
});

// ---- admin-predetermined approval rules ------------------------------------------------------

describe('admin-predetermined approval rules', () => {
  it("rule 'allow' pre-authorizes a dangerous tool for a non-admin", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { rules: [{ tool: 'danger_*', decision: 'allow' }] } } });
    const { executor, registry, bus } = makeExecutor(cfg);
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(true);
    expect(ran.value).toBe(true);
  });

  it("rule 'deny' blocks a tool even when a handler would approve", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { rules: [{ toolset: 'test', decision: 'deny' }] } } });
    const { executor, registry, bus } = makeExecutor(cfg);
    const approvals = new ApprovalService(bus);
    approvals.setHandler('cli', async () => true);
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'cli', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(false);
    expect(ran.value).toBe(false);
  });

  it("rule 'allow' does NOT escalate an untrusted-derived sensitive call (falls to the gate)", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { rules: [{ tool: 'mod_act', decision: 'allow' }] } } });
    const { judgment, calls } = gateStub({ approve: false });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(moderateApprovalTool(ran, true));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('mod_act'), ctx, freshState(true));
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(1); // the allow rule deferred to the gate for the tainted call
  });

  it("appliesTo='non-admin' leaves admins on the normal path", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { rules: [{ tool: 'danger_*', decision: 'deny', appliesTo: 'non-admin' }] } } });
    const { executor, registry, bus } = makeExecutor(cfg);
    const approvals = new ApprovalService(bus);
    approvals.setHandler('cli', async () => true); // admin can answer
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const ctx = ctxFor({ platform: 'cli', approvals, role: 'admin' });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(true); // admin not blocked by the non-admin rule
    expect(ran.value).toBe(true);
  });

  it("rule 'gate' consults the gate", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { rules: [{ tool: 'danger_*', decision: 'gate' }] } } });
    const { judgment, calls } = gateStub({ approve: true });
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    const ran = { value: false };
    registry.register(dangerTool(ran));
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor({ platform: 'web', approvals });
    const res = await executor.execute(call('danger_do'), ctx, freshState());
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});
