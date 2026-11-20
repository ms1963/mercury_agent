/**
 * Feature — Proactive (but not annoying).
 *
 * Covers the interrupt-timing priority model ({@link scorePriority}), the declarative rule matcher
 * (source/kind glob + substring), interrupt-vs-defer routing against the configured threshold, rule
 * route overrides, digest accumulation + flush, and the real {@link GatewayEmailSource} reacting to
 * the `gateway.inbound` bus event the email adapter emits. Uses an in-memory DB and the real
 * EventBus / runtime; no product-code mocks (deliver/runAction spies live only in these tests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema, Db, EventBus, ProactiveService, scorePriority } from '@mercury/core';
import { makeMercury } from './helpers.js';

const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse(o);
const proCfg = (p: Record<string, unknown> = {}) => cfg({ proactive: { enabled: true, ...p } });

describe('scorePriority (interrupt-timing model)', () => {
  it('returns the base priority with no signals', () => {
    expect(scorePriority({ kind: 'received', title: 'hello', body: 'just saying hi' }, 0.5)).toBeCloseTo(0.5, 3);
  });

  it('raises priority for urgent signals and clamps at 1', () => {
    const s = scorePriority({ kind: 'alert', title: 'CRITICAL security breach detected' }, 0.9);
    expect(s).toBe(1);
  });

  it('lowers priority for low-value signals (newsletter/FYI)', () => {
    const s = scorePriority({ kind: 'received', title: 'Our monthly newsletter', body: 'promotion inside' }, 0.5);
    expect(s).toBeLessThan(0.5);
  });

  it('bumps CI/build failures above a neutral base', () => {
    const s = scorePriority({ kind: 'build.failed', title: 'CI pipeline failed on main' }, 0.5);
    expect(s).toBeGreaterThanOrEqual(0.8); // +0.3 urgent (fail) +0.15 build-fail
  });

  it('never drops below 0 for stacked low signals', () => {
    expect(scorePriority({ kind: 'newsletter', title: 'fyi marketing promo' }, 0.1)).toBeGreaterThanOrEqual(0);
  });
});

describe('ProactiveService.matchRule', () => {
  const svc = new ProactiveService(
    proCfg({
      rules: [
        { id: 'ci', source: 'webhook', kind: 'build.*', action: 'Investigate {{title}}', priority: 0.8, route: 'interrupt' },
        { id: 'news', source: 'email', kind: 'received', contains: 'newsletter', priority: 0.2, route: 'digest' },
        { id: 'any', source: '*', kind: '*', priority: 0.5 },
      ],
    }),
  );

  it('matches a kind glob', () => {
    expect(svc.matchRule({ source: 'webhook', kind: 'build.failed' })?.id).toBe('ci');
  });

  it('requires the substring when `contains` is set', () => {
    expect(svc.matchRule({ source: 'email', kind: 'received', title: 'Weekly newsletter' })?.id).toBe('news');
    expect(svc.matchRule({ source: 'email', kind: 'received', title: 'Lunch?' })?.id).toBe('any');
  });

  it('falls through to the catch-all rule', () => {
    expect(svc.matchRule({ source: 'calendar', kind: 'conflict' })?.id).toBe('any');
  });
});

describe('ProactiveService ingest / digest (in-memory DB)', () => {
  it('interrupts high-priority events and defers low-priority ones by threshold', async () => {
    const delivered: string[] = [];
    const svc = new ProactiveService(proCfg({ interruptThreshold: 0.7 }), new Db(':memory:'), new EventBus(), {
      deliver: async (t) => void delivered.push(t),
    });
    const urgent = await svc.ingest({ source: 'webhook', kind: 'build.failed', title: 'CI failed', priority: 0.6 });
    const chit = await svc.ingest({ source: 'email', kind: 'received', title: 'newsletter', priority: 0.3 });
    expect(urgent.decision).toBe('interrupt');
    expect(urgent.status).toBe('notified');
    expect(chit.decision).toBe('defer');
    expect(chit.status).toBe('deferred');
    expect(delivered).toHaveLength(1); // only the interrupt notified immediately
  });

  it('honours a rule route override and runs the matched action', async () => {
    const actions: string[] = [];
    const svc = new ProactiveService(
      proCfg({
        interruptThreshold: 0.99,
        rules: [{ id: 'force', source: 'webhook', kind: 'deploy.done', action: 'Announce {{title}}', priority: 0.4, route: 'interrupt' }],
      }),
      new Db(':memory:'),
      new EventBus(),
      { runAction: async (t) => void actions.push(t) },
    );
    const ev = await svc.ingest({ source: 'webhook', kind: 'deploy.done', title: 'v1 shipped' });
    expect(ev.decision).toBe('interrupt'); // route override beats the (unreachable) threshold
    expect(ev.rule).toBe('force');
    expect(actions).toEqual(['Announce v1 shipped']);
  });

  it('accumulates deferred events and flushes them into one digest', async () => {
    const delivered: string[] = [];
    const svc = new ProactiveService(proCfg({ interruptThreshold: 0.95 }), new Db(':memory:'), new EventBus(), {
      deliver: async (t) => void delivered.push(t),
    });
    await svc.ingest({ source: 'email', kind: 'received', title: 'FYI one', priority: 0.3 });
    await svc.ingest({ source: 'email', kind: 'received', title: 'FYI two', priority: 0.3 });
    await svc.ingest({ source: 'rss', kind: 'post', title: 'new article', priority: 0.3 });
    expect(svc.deferred()).toHaveLength(3);

    const digest = await svc.flushDigest();
    expect(digest.count).toBe(3);
    expect(digest.summary).toContain('email (2)');
    expect(digest.summary).toContain('rss (1)');
    expect(delivered).toHaveLength(1); // one digest delivery, not three interrupts
    expect(svc.deferred()).toHaveLength(0); // queue drained
    expect(svc.events().every((e) => e.status !== 'deferred')).toBe(true);
  });

  it('flushing an empty queue is a no-op', async () => {
    const svc = new ProactiveService(proCfg(), new Db(':memory:'), new EventBus());
    const d = await svc.flushDigest();
    expect(d.count).toBe(0);
  });

  it('exposes configured rules in a UI-friendly shape', () => {
    const svc = new ProactiveService(proCfg({ rules: [{ id: 'r1', source: 'ci', kind: 'build.*', description: 'CI', priority: 0.8 }] }));
    expect(svc.rules()).toEqual([{ id: 'r1', source: 'ci', kind: 'build.*', route: '', priority: 0.8, description: 'CI' }]);
  });
});

describe('GatewayEmailSource (real bus wiring)', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  beforeAll(async () => {
    ctx = await makeMercury({ proactive: { enabled: true, interruptThreshold: 0.5 } });
    ctx.m.proactive.start(); // subscribe sources to the real bus (startServices:false in tests)
  });
  afterAll(() => ctx.close());

  it('registers the email and webhook sources', () => {
    expect(ctx.m.proactive.sourceNames()).toEqual(expect.arrayContaining(['email', 'webhook']));
  });

  it('turns a real gateway.inbound email event into a proactive event', async () => {
    ctx.m.bus.emit({
      type: 'gateway.inbound',
      data: { platform: 'email', from: 'boss@acme.com', displayName: 'The Boss', subject: 'URGENT: prod down', preview: 'the site is down' },
    });
    await new Promise((r) => setTimeout(r, 20)); // ingest is fire-and-forget
    const events = ctx.m.proactive.events();
    expect(events.length).toBeGreaterThan(0);
    const top = events[0];
    expect(top.source).toBe('email');
    expect(top.title).toContain('The Boss');
    expect(top.decision).toBe('interrupt'); // "URGENT"/"down" push it over the threshold
  });

  it('ignores inbound messages from non-subscribed platforms', async () => {
    const before = ctx.m.proactive.events().length;
    ctx.m.bus.emit({ type: 'gateway.inbound', data: { platform: 'slack', from: 'x', subject: 'hi' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.m.proactive.events().length).toBe(before);
  });

  it('poll returns zero when no source actively polls', async () => {
    expect((await ctx.m.proactive.poll()).polled).toBe(0);
  });
});
