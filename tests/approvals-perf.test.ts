/**
 * Performance / throughput tests for the approval gating path.
 *
 * The historical bug: a gated tool call on a platform with no interactive handler waited the FULL
 * 5-minute approval timeout before auto-denying, stalling every chat turn over the HTTP API.
 *
 * These tests assert the fix is fast and deterministic WITHOUT any real network/LLM:
 *  - an unanswerable gated call resolves in milliseconds, not minutes;
 *  - the unattended 'wait' path honours a short configured timeout (<< 5 min);
 *  - the smart gate is memoized/coalesced: identical gated calls in a run issue ONE judgment call;
 *  - ApprovalService honours a small configured no-handler timeout.
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

const OLD_TIMEOUT_MS = 5 * 60_000; // the removed hard-coded default we must beat by a wide margin

const principal: Principal = { userId: 'user-1', username: 'user', role: 'user', kind: 'user', scopes: ['*'] };

function gateStub(approve: boolean) {
  const fn = vi.fn(async () => ({ approve, probability: approve ? 0.9 : 0.1 }));
  return { judgment: { gateToolCall: fn } as unknown as Judgment, fn };
}

function makeExecutor(cfg: MercuryConfig, judgment?: Judgment) {
  const bus = new EventBus();
  const registry = new ToolRegistry(cfg);
  const executor = new ToolExecutor(cfg, registry, new PolicyEngine(), bus, judgment, undefined, undefined);
  return { bus, registry, executor };
}

function moderateApprovalTool() {
  return defineTool({
    name: 'mod_act',
    description: 'moderate tool needing approval',
    toolset: 'test',
    risk: 'moderate',
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    needsApproval: () => 'needs approval',
    async execute() {
      return { content: 'ok' };
    },
  });
}

function ctxFor(platform: string, approvals: ApprovalService, runId = 'run-fixed'): ToolContext {
  return {
    principal,
    runId,
    platform,
    workdir: '/tmp',
    depth: 0,
    services: {} as unknown as ToolServices,
    emit: () => {},
    requestApproval: (req) => approvals.request(req, { userId: 'user-1', platform }),
    approvalAnswerable: () => approvals.isAnswerable(platform),
  };
}

const state = (): RunSecurityState => ({ untrustedSeen: false, userRequest: 'do it' });
const call = (args: Record<string, unknown> = { x: '1' }) => ({ id: 'c', name: 'mod_act', arguments: args });

describe('approval fast-path performance', () => {
  it('an unanswerable gated call resolves in milliseconds, not minutes', async () => {
    const cfg = ConfigSchema.parse({}); // manual + unattended gate defaults
    const { judgment } = gateStub(false); // gate rejects -> fast deny
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    registry.register(moderateApprovalTool());
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor('web', approvals);
    const t0 = Date.now();
    const res = await executor.execute(call(), ctx, state());
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeLessThan(OLD_TIMEOUT_MS / 10);
  });

  it("unattended='wait' honours a tiny no-handler timeout instead of 5 minutes", async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { unattended: 'wait', noHandlerTimeoutMs: 40 } } });
    const { executor, registry, bus } = makeExecutor(cfg);
    registry.register(moderateApprovalTool());
    const approvals = new ApprovalService(bus, { noHandlerTimeoutMs: 40 });
    const ctx = ctxFor('web', approvals);
    const t0 = Date.now();
    const res = await executor.execute(call(), ctx, state());
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false); // timed out -> denied
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('memoizes the smart gate: identical gated calls in a run issue ONE judgment call', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'smart' } } });
    const { judgment, fn } = gateStub(true);
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    registry.register(moderateApprovalTool());
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor('web', approvals, 'run-memo');
    // Three identical gated calls in the SAME run.
    await executor.execute(call({ x: 'same' }), ctx, state());
    await executor.execute(call({ x: 'same' }), ctx, state());
    await executor.execute(call({ x: 'same' }), ctx, state());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT share memo across different arguments (distinct gate calls)', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'smart' } } });
    const { judgment, fn } = gateStub(true);
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    registry.register(moderateApprovalTool());
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor('web', approvals, 'run-memo2');
    await executor.execute(call({ x: 'a' }), ctx, state());
    await executor.execute(call({ x: 'b' }), ctx, state());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical gated calls into one judgment (single-flight)', async () => {
    const cfg = ConfigSchema.parse({ tools: { approvals: { mode: 'smart' } } });
    let resolveGate: (v: { approve: boolean; probability: number }) => void = () => {};
    const fn = vi.fn(() => new Promise<{ approve: boolean; probability: number }>((r) => (resolveGate = r)));
    const judgment = { gateToolCall: fn } as unknown as Judgment;
    const { executor, registry, bus } = makeExecutor(cfg, judgment);
    registry.register(moderateApprovalTool());
    const approvals = new ApprovalService(bus);
    const ctx = ctxFor('web', approvals, 'run-sf');
    const p1 = executor.execute(call({ x: 'same' }), ctx, state());
    const p2 = executor.execute(call({ x: 'same' }), ctx, state());
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    resolveGate({ approve: true, probability: 0.9 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // both calls shared a single in-flight judgment
  });
});

describe('ApprovalService timeout configuration', () => {
  it('no-handler request denies after the small configured noHandlerTimeoutMs', async () => {
    const bus = new EventBus();
    const approvals = new ApprovalService(bus, { noHandlerTimeoutMs: 30 });
    const t0 = Date.now();
    const decision = await approvals.request({ title: 'x', detail: 'd', tool: 'mod_act', args: {}, risk: 'moderate' }, { userId: 'user-1', platform: 'web' });
    const elapsed = Date.now() - t0;
    expect(decision).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('isAnswerable reflects handlers and apiAnswerablePlatforms', () => {
    const bus = new EventBus();
    const approvals = new ApprovalService(bus, { apiAnswerablePlatforms: ['web'] });
    expect(approvals.isAnswerable('web')).toBe(true);
    expect(approvals.isAnswerable('telegram')).toBe(false);
    approvals.setHandler('cli', async () => true);
    expect(approvals.isAnswerable('cli')).toBe(true);
    expect(approvals.hasHandler('cli')).toBe(true);
    expect(approvals.hasHandler('web')).toBe(false);
  });

  it('default no-handler timeout is far below the old 5-minute default (handler path immediate)', async () => {
    const bus = new EventBus();
    const approvals = new ApprovalService(bus); // defaults
    approvals.setHandler('cli', async () => true);
    const t0 = Date.now();
    const decision = await approvals.request({ title: 'x', detail: 'd', tool: 't', args: {}, risk: 'safe' }, { userId: 'user-1', platform: 'cli' });
    expect(decision).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
