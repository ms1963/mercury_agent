/**
 * Management routes used by the web UI panels: tools, MCP, skills, memory,
 * workflows, scheduler, gateway, models/router/budgets, reflections, decisions,
 * observability/debug, help, i18n and settings.
 */
import type { FastifyInstance } from 'fastify';
import { installSkills, insights, redactDeep, setConfigValue, buildTrace, type MercuryEvent } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { HttpError, type Ctx } from '../http.js';

type Body = Record<string, unknown>;
const param = (req: { params: unknown }, k = 'id') => (req.params as Body)[k] as string;

export function registerManageRoutes(app: FastifyInstance, { m, auth, sse }: Ctx): void {
  // ---- tools & MCP --------------------------------------------------------
  app.get('/api/tools', async (req) => {
    auth(req);
    return {
      toolsets: m.tools.toolsets(),
      tools: m.tools.list().map((t) => ({ name: t.name, description: t.description, toolset: t.toolset, risk: t.risk, source: t.source, enabled: m.tools.isEnabled(t) })),
    };
  });
  app.post('/api/tools/toggle', async (req) => {
    auth(req, 'tools.manage');
    const b = req.body as Body;
    if (b.toolset) m.tools.setToolsetEnabled(String(b.toolset), Boolean(b.enabled));
    if (b.tool) m.tools.setToolEnabled(String(b.tool), Boolean(b.enabled));
    return { ok: true };
  });
  app.post('/api/tools/:name/run', async (req) => {
    const p = auth(req, 'tool.use');
    const r = await m.executor.execute({ id: 'manual', name: param(req, 'name'), arguments: (req.body as Body) ?? {} }, directToolContext(m, p, 'web'), { untrustedSeen: false, userRequest: 'manual tool run from the web UI' });
    return { ok: r.ok, content: r.result.content, durationMs: r.durationMs };
  });
  app.get('/api/mcp', async (req) => (auth(req), { servers: m.mcp.status(), serverEndpoint: m.config.mcp.server.enabled ? m.config.mcp.server.path : null }));
  app.post('/api/mcp', async (req) => {
    auth(req, 'tools.manage');
    const b = req.body as Body;
    return m.mcp.connect(String(b.name), b.config as never);
  });
  app.delete('/api/mcp/:name', async (req) => (auth(req, 'tools.manage'), await m.mcp.disconnect(param(req, 'name')), { ok: true }));

  // ---- skills --------------------------------------------------------------
  app.get('/api/skills', async (req) => (auth(req), { skills: m.skills.list().map((s) => ({ ...s.meta, source: s.source, stats: s.stats })) }));
  app.get('/api/skills/:name', async (req) => (auth(req), { name: param(req, 'name'), body: m.skills.view(param(req, 'name')), files: m.skills.files(param(req, 'name')) }));
  app.post('/api/skills', async (req) => {
    const p = auth(req, 'skills.manage');
    const b = req.body as Body;
    if (b.source) return { installed: installSkills(m.skills, String(b.source)) };
    return m.skills.create({ name: String(b.name), description: String(b.description ?? ''), body: String(b.body ?? ''), tags: b.tags as string[] | undefined, author: p.username }).meta;
  });
  app.put('/api/skills/:name', async (req) => {
    auth(req, 'skills.manage');
    const b = req.body as Body;
    return m.skills.update(param(req, 'name'), { body: b.body as string | undefined, description: b.description as string | undefined }).meta;
  });

  // ---- memory ---------------------------------------------------------------
  app.get('/api/memory', async (req) => {
    const p = auth(req, 'memory.read');
    const q = (req.query as Body).q as string | undefined;
    return {
      facts: q ? await m.memory.recall(p.userId, q, 20) : m.memory.facts.list(p.userId, { limit: 200 }),
      curated: { memory: m.memory.curated.read(p.userId, 'memory'), user: m.memory.curated.read(p.userId, 'user') },
      usage: m.memory.curated.usage(p.userId),
      profile: m.memory.userModel.get(p.userId),
      providers: m.memory.providerNames(),
    };
  });
  app.post('/api/memory', async (req) => {
    const p = auth(req, 'memory.write');
    const b = req.body as Body;
    return m.memory.remember(p.userId, String(b.content), { kind: b.kind as never, tags: b.tags as string[] | undefined, source: 'web' });
  });
  app.delete('/api/memory/:id', async (req) => ({ removed: await m.memory.forget(auth(req, 'memory.write').userId, param(req)) }));
  app.put('/api/memory/curated/:which', async (req) => {
    const p = auth(req, 'memory.write');
    const which = param(req, 'which');
    if (which !== 'memory' && which !== 'user') throw new HttpError(400, 'which must be memory or user');
    m.memory.curated.write(p.userId, which, String((req.body as Body).content ?? ''));
    return { ok: true };
  });

  // ---- workflows ------------------------------------------------------------
  app.get('/api/workflows', async (req) => (auth(req), { workflows: m.workflows.list(), templates: m.workflows.listTemplates() }));
  app.post('/api/workflows', async (req) => (auth(req, 'workflow.run'), m.workflows.save(req.body as never)));
  app.post('/api/workflows/:name/run', async (req, reply) => {
    const p = auth(req, 'workflow.run');
    const b = req.body as Body;
    const stream = sse(req, reply);
    const off = m.bus.on('*', (e: MercuryEvent) => {
      if (e.userId === p.userId || e.type.startsWith('workflow.')) stream.send('event', e);
    });
    try {
      const r = await m.workflows.run(param(req, 'name'), String(b.input ?? ''), { principal: p, platform: 'web' });
      stream.send('done', r);
    } catch (err) {
      stream.send('error', { error: (err as Error).message });
    } finally {
      off();
      stream.end();
    }
  });

  // ---- scheduler ------------------------------------------------------------
  const sched = (req: Parameters<typeof auth>[0]) => {
    const p = auth(req, 'schedule.manage');
    return { p, owner: p.role === 'admin' ? undefined : p.userId };
  };
  app.get('/api/schedules', async (req) => ({ schedules: m.scheduler.list(sched(req).owner) }));
  app.post('/api/schedules', async (req) => m.scheduler.create(sched(req).p.userId, req.body as never));
  app.patch('/api/schedules/:id', async (req) => m.scheduler.update(param(req), req.body as never, sched(req).owner));
  app.delete('/api/schedules/:id', async (req) => (m.scheduler.delete(param(req), sched(req).owner), { ok: true }));
  app.post('/api/schedules/:id/:action', async (req) => {
    const { owner } = sched(req);
    const id = param(req);
    switch (param(req, 'action')) {
      case 'pause':
        return m.scheduler.pause(id, owner);
      case 'resume':
        return m.scheduler.resume(id, owner);
      case 'run': {
        // A manual run executes the full agent loop, which can take minutes. The server
        // uses synchronous SQLite on a single thread, so awaiting the run here would hold
        // the HTTP request open and starve every other request (pause/refresh/auth hang,
        // panels render blank). Validate ownership synchronously, then fire-and-forget.
        const s = m.scheduler.get(id);
        if (!s || (owner && s.userId !== owner)) throw new HttpError(404, 'schedule not found');
        void m.scheduler.runNow(id, owner).catch((err) => req.log.error({ err, id }, 'manual schedule run failed'));
        return { ok: true, started: true };
      }
      default:
        throw new HttpError(400, 'unknown action');
    }
  });
  app.get('/api/schedules/:id/history', async (req) => (sched(req), { runs: m.scheduler.history(param(req)) }));

  // ---- gateway ----------------------------------------------------------------
  app.get('/api/gateway', async (req) => {
    const p = auth(req);
    const admin = p.role === 'admin';
    return { enabled: m.config.gateway.enabled, adapters: m.gateway.status(), pairing: admin ? m.pairing.listPending() : [], review: admin ? m.gateway.reviewQueue() : [], identities: m.users.listIdentities(p.userId) };
  });
  app.post('/api/gateway/pair/:code', async (req) => {
    const p = auth(req);
    const b = req.body as Body;
    if (b.reject) return (auth(req, 'gateway.manage'), m.pairing.reject(param(req, 'code'), p.userId), { ok: true });
    // Users link codes to themselves; admins may link to any user.
    const target = p.role === 'admin' && b.userId ? String(b.userId) : p.userId;
    return m.pairing.approve(param(req, 'code'), target, p.userId);
  });
  app.post('/api/gateway/review/:id', async (req) => {
    auth(req, 'gateway.manage');
    await m.gateway.resolveReview(param(req), (req.body as Body).action === 'respond' ? 'respond' : 'dismiss');
    return { ok: true };
  });

  // ---- models, router, budgets, usage -------------------------------------------
  app.get('/api/models', async (req) => {
    auth(req);
    return { defaultModel: m.config.llm.defaultModel, providers: m.providers.list().map((p) => p.id), profiles: m.providers.profilesList(), router: m.config.router, patterns: m.patterns.list().map((p) => ({ name: p.name, description: p.description })), personalities: m.personalities.list().map((p) => ({ name: p.name, title: p.title })) };
  });
  app.post('/api/models/route', async (req) => (auth(req), m.router.route({ task: String((req.body as Body).task ?? '') })));
  app.get('/api/budgets', async (req) => {
    const p = auth(req);
    return { rules: m.budgets.rules(), report: m.budgets.report(p.role === 'admin' ? '*' : p.userId, 30), insights: insights(m.db, p.role === 'admin' ? undefined : p.userId, 30) };
  });
  app.post('/api/budgets', async (req) => (auth(req, 'budgets.manage'), m.budgets.setBudget(req.body as never)));
  app.delete('/api/budgets/:id', async (req) => (auth(req, 'budgets.manage'), m.budgets.deleteBudget(param(req)), { ok: true }));

  // ---- per-task economics: hard budgets + running cost-vs-value estimate --------
  app.get('/api/tasks', async (req) => {
    auth(req);
    const tasks = m.taskBudgets.all().map((t) => ({ ...t, costVsValue: m.taskBudgets.costVsValue(t.taskId) }));
    return { config: m.config.budgets.perTask, economics: m.config.router.economics, active: tasks.filter((t) => t.state === 'active'), tasks };
  });
  app.get('/api/tasks/:id', async (req) => {
    auth(req);
    const budget = m.taskBudgets.get(param(req));
    if (!budget) throw new HttpError(404, 'task not found');
    return { budget, costVsValue: m.taskBudgets.costVsValue(param(req)) };
  });

  // ---- reflections & decisions (Jev) ---------------------------------------------
  app.get('/api/reflections', async (req) => {
    const p = auth(req);
    return { reflections: m.reflector.list(p.role === 'admin' ? undefined : p.userId) };
  });
  app.get('/api/decisions', async (req) => {
    auth(req);
    const purpose = (req.query as Body).purpose as string | undefined;
    return { chain: m.decisions.chain(), recent: m.decisions.recent(100, purpose), calibration: m.decisions.calibration(purpose), thresholds: m.config.decision.thresholds };
  });
  app.post('/api/decisions/try', async (req) => {
    auth(req);
    const b = req.body as Body;
    return m.decisions.decide({ state: b.state ?? '', questions: b.questions as never, purpose: 'playground' });
  });

  // ---- observability & debug -------------------------------------------------------
  app.get('/api/runs', async (req) => {
    const p = auth(req);
    return { runs: m.recorder.runs(p.role === 'admin' ? undefined : p.userId, 100) };
  });
  app.get('/api/runs/:id/events', async (req) => {
    const p = auth(req);
    const events = m.recorder.replay(param(req));
    if (p.role !== 'admin' && events.some((e) => e.userId && e.userId !== p.userId)) throw new HttpError(404, 'run not found');
    const children = m.db.all('SELECT id, kind, status, depth FROM runs WHERE parent_run_id = ?', param(req));
    return { events, children };
  });
  app.get('/api/events', async (req, reply) => {
    const p = auth(req);
    const stream = sse(req, reply);
    stream.onClose(m.bus.on('*', (e: MercuryEvent) => {
      if (e.type === 'llm.delta' || e.type === 'log') return;
      if (p.role === 'admin' || e.userId === p.userId) stream.send('event', e);
    }));
  });
  app.get('/api/debug', async (req) => (auth(req, 'debug'), { breakpoints: m.debug.getGlobal(), paused: m.debug.list() }));
  app.post('/api/debug/breakpoints', async (req) => (auth(req, 'config.manage'), m.debug.setGlobal(req.body as never)));
  app.post('/api/debug/resume/:id', async (req) => (auth(req, 'debug'), { ok: m.debug.resume(param(req), ((req.body as Body) ?? { action: 'continue' }) as never) }));
  app.get('/api/audit', async (req) => {
    auth(req, 'audit.read');
    const q = req.query as Body;
    const num = (v: unknown): number | undefined => (v === undefined || v === '' ? undefined : Number(v));
    const filtered = q.actor || q.action || q.target || q.since || q.until || q.limit || q.offset;
    if (!filtered) return { entries: m.audit.list(200), integrity: m.audit.verify() };
    const { entries, total } = m.audit.query({
      actor: q.actor ? String(q.actor) : undefined,
      action: q.action ? String(q.action) : undefined,
      target: q.target ? String(q.target) : undefined,
      since: q.since ? String(q.since) : undefined,
      until: q.until ? String(q.until) : undefined,
      limit: num(q.limit),
      offset: num(q.offset),
    });
    return { entries, total, integrity: m.audit.verify() };
  });

  // ---- replayable audit trail: full ordered "why did you do that?" trace per run -----
  app.get('/api/runs/:id/trace', async (req) => {
    const p = auth(req);
    const events = m.recorder.replay(param(req));
    if (p.role !== 'admin' && events.some((e) => e.userId && e.userId !== p.userId)) throw new HttpError(404, 'run not found');
    return buildTrace(events, param(req));
  });

  // ---- governance: least-privilege capability grants (time-limited, no standing keys) ----
  app.get('/api/grants', async (req) => {
    auth(req, 'audit.read');
    const taskId = (req.query as Body).taskId as string | undefined;
    return { enabled: m.config.security.grants.enabled, config: m.config.security.grants, grants: m.grants.list(taskId) };
  });
  app.post('/api/grants', async (req) => {
    const p = auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.capability || !b.taskId) throw new HttpError(400, 'capability and taskId are required');
    return m.grants.issue({
      capability: String(b.capability),
      taskId: String(b.taskId),
      scope: b.scope ? String(b.scope) : undefined,
      grantedBy: p.username,
      ttlMs: b.ttlMs === undefined ? undefined : Number(b.ttlMs),
      maxUses: b.maxUses === undefined ? undefined : Number(b.maxUses),
    });
  });
  app.delete('/api/grants/:id', async (req) => {
    const p = auth(req, 'config.manage');
    return { revoked: m.grants.revoke(param(req), p.username) };
  });

  // ---- governance: policy-as-code (declarative rules before sensitive actions) --------
  app.get('/api/policies', async (req) => {
    auth(req, 'audit.read');
    return { enabled: m.config.security.policies.enabled, config: m.config.security.policies, rules: m.codePolicies.list() };
  });
  app.post('/api/policies/test', async (req) => {
    auth(req, 'audit.read');
    const b = req.body as Body;
    if (!b.tool) throw new HttpError(400, 'tool is required');
    return m.codePolicies.evaluate(String(b.tool), (b.args as Body) ?? {}, { tainted: Boolean(b.tainted) });
  });

  // ---- help, i18n, settings ---------------------------------------------------------
  app.get('/api/help', async (req) => {
    const q = req.query as Body;
    if (q.topic) return { topic: q.topic, content: m.help.get(String(q.topic), q.locale as string | undefined) ?? 'Topic not found.' };
    return { topics: q.q ? m.help.search(String(q.q)) : m.help.topics() };
  });
  app.get('/api/i18n', async () => ({ locales: m.i18n.locales(), default: m.config.locale }));
  app.get('/api/i18n/:locale', async (req) => m.i18n.catalog(param(req, 'locale')));
  app.get('/api/settings', async (req) => (auth(req, 'config.manage'), { file: m.configFile, config: redactDeep(m.config) }));
  app.post('/api/settings', async (req) => {
    const p = auth(req, 'config.manage');
    const b = req.body as Body;
    const file = setConfigValue(String(b.key), b.value, m.configFile);
    m.audit.record(p.userId, 'config.set', String(b.key));
    return { ok: true, file, note: 'Saved. Restart Mercury to apply.' };
  });
}
