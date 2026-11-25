/**
 * Management routes used by the web UI panels: tools, MCP, skills, memory,
 * workflows, scheduler, gateway, models/router/budgets, reflections, decisions,
 * observability/debug, help, i18n and settings.
 */
import type { FastifyInstance } from 'fastify';
import { installSkills, insights, redactDeep, setConfigValue, buildTrace, type MercuryEvent } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { enablePresetConfig, mcpPreset, mcpPresets } from '@mercury/mcp';
import { HttpError, publicError, type Ctx } from '../http.js';

type Body = Record<string, unknown>;
const param = (req: { params: unknown }, k = 'id') => (req.params as Body)[k] as string;

export function registerManageRoutes(app: FastifyInstance, { m, auth, sse }: Ctx): void {
  /** True when `p` may see run-scoped data for `runId` (admin, or the run's owner). */
  const ownsRun = (p: { userId: string; role: string }, runId: string): boolean => {
    if (p.role === 'admin') return true;
    const row = m.db.get<{ user_id: string | null }>('SELECT user_id FROM runs WHERE id = ?', runId);
    return !!row && row.user_id === p.userId;
  };
  /** Run events are readable by the owner (runs table, or — for runs without a row — events that name only them). */
  const canSeeRun = (p: { userId: string; role: string }, runId: string, events: Array<{ userId?: string }>): boolean => {
    if (p.role === 'admin') return true;
    if (events.some((e) => e.userId && e.userId !== p.userId)) return false;
    const row = m.db.get<{ user_id: string | null }>('SELECT user_id FROM runs WHERE id = ?', runId);
    return row ? row.user_id === p.userId : events.some((e) => e.userId === p.userId);
  };
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

  // ---- optional MCP integrations (curated presets, off by default) ----------
  // Secrets are NOT entered here — they live in ~/.mercury/.env; the UI only toggles enablement and
  // shows which env vars each preset needs. A restart applies new env values.
  app.get('/api/integrations', async (req) => {
    auth(req);
    const configured = m.config.mcp.servers;
    const live = new Map(m.mcp.status().map((s) => [s.name, s]));
    return {
      presets: mcpPresets().map((p) => {
        const cfg = configured[p.name];
        const missingEnv = p.requiredEnv.filter((e) => !process.env[e]);
        return {
          name: p.name, description: p.description, provenance: p.provenance, pkg: p.pkg,
          requiredEnv: p.requiredEnv, notes: p.notes,
          configured: !!cfg, enabled: cfg?.enabled ?? false, missingEnv,
          connected: live.get(p.name)?.connected ?? false, tools: live.get(p.name)?.tools?.length ?? 0,
        };
      }),
    };
  });
  app.post('/api/integrations/:name/enable', async (req) => {
    auth(req, 'tools.manage');
    const name = param(req, 'name');
    const preset = mcpPreset(name);
    if (!preset) throw new HttpError(404, `unknown preset "${name}"`);
    const resolved = enablePresetConfig(preset);
    setConfigValue(`mcp.servers.${name}`, resolved.config, m.configFile);
    return { ok: true, name, enabled: true, missingEnv: resolved.missingEnv, note: 'Saved to config (enabled). Set any missing env vars in ~/.mercury/.env, then restart to connect.' };
  });
  app.post('/api/integrations/:name/disable', async (req) => {
    auth(req, 'tools.manage');
    const name = param(req, 'name');
    if (!m.config.mcp.servers[name]) throw new HttpError(404, `no configured server "${name}"`);
    setConfigValue(`mcp.servers.${name}.enabled`, false, m.configFile);
    await m.mcp.disconnect(name).catch(() => undefined);
    return { ok: true, name, enabled: false };
  });

  // ---- skills --------------------------------------------------------------
  app.get('/api/skills', async (req) => (auth(req), { skills: m.skills.list().map((s) => ({ ...s.meta, source: s.source, stats: s.stats })) }));
  app.get('/api/skills/:name', async (req) => (auth(req), { name: param(req, 'name'), body: m.skills.view(param(req, 'name')), files: m.skills.files(param(req, 'name')) }));
  app.post('/api/skills', async (req) => {
    const p = auth(req, 'skills.manage');
    const b = req.body as Body;
    // Installing third-party skill packs changes the prompt context of every user → admin only.
    if (b.source) return (auth(req, 'tools.manage'), { installed: installSkills(m.skills, String(b.source)) });
    return m.skills.create({ name: String(b.name), description: String(b.description ?? ''), body: String(b.body ?? ''), tags: b.tags as string[] | undefined, author: p.username }).meta;
  });
  app.put('/api/skills/:name', async (req) => {
    const p = auth(req, 'skills.manage');
    const b = req.body as Body;
    // Skills are shared: only their author (or an admin) may rewrite them.
    const existing = m.skills.get(param(req, 'name'));
    if (existing && p.role !== 'admin' && existing.meta.author !== p.username) throw new HttpError(403, 'only the skill author or an admin may edit this skill');
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
  app.get('/api/memory/namespaces', async (req) => {
    const p = auth(req, 'memory.read');
    return { namespaces: m.memory.namespaces(p.userId) };
  });
  app.get('/api/memory/audit', async (req) => {
    const p = auth(req, 'memory.read');
    const q = req.query as Body;
    return m.memory.auditLog({
      userId: p.userId,
      namespace: q.namespace as string | undefined,
      action: q.action as never,
      decision: q.decision as never,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });
  app.get('/api/memory/knowledge', async (req) => {
    const p = auth(req, 'memory.read');
    const q = req.query as Body;
    const query = q.q as string | undefined;
    if (query) return { chunks: await m.memory.searchKnowledge(p.userId, query, q.k ? Number(q.k) : undefined, { namespace: q.namespace as string | undefined }) };
    return { sources: m.memory.knowledge.sources(p.userId, q.namespace as string | undefined) };
  });
  app.post('/api/memory/knowledge', async (req) => {
    const p = auth(req, 'memory.write');
    const b = req.body as Body;
    return await m.memory.addKnowledge(p.userId, { title: b.title as string | undefined, uri: b.uri as string | undefined, content: String(b.content ?? ''), tags: b.tags as string[] | undefined }, { namespace: b.namespace as string | undefined, principal: p });
  });

  // ---- teams ----------------------------------------------------------------
  app.get('/api/teams', async (req) => (auth(req, 'teams.manage'), { teams: m.teams.list() }));
  app.post('/api/teams', async (req) => {
    const p = auth(req, 'teams.manage');
    return m.teams.define(p, req.body as never);
  });
  app.get('/api/teams/runs', async (req) => {
    const p = auth(req, 'teams.run');
    // Non-admins only see the team runs they started.
    return { runs: m.teams.listRuns((req.query as Body).team as string | undefined, undefined, p.role === 'admin' ? undefined : p.userId) };
  });
  app.get('/api/teams/runs/:id', async (req) => {
    const p = auth(req, 'teams.run');
    const r = m.teams.getRun(param(req));
    if (!r || (p.role !== 'admin' && r.userId !== p.userId)) throw new HttpError(404, 'run not found');
    return r;
  });
  app.get('/api/teams/:id', async (req) => {
    auth(req, 'teams.manage');
    const t = m.teams.get(param(req));
    if (!t) throw new HttpError(404, 'team not found');
    return t;
  });
  app.delete('/api/teams/:id', async (req) => { const p = auth(req, 'teams.manage'); return { removed: m.teams.delete(p, param(req)) }; });
  app.post('/api/teams/:id/run', async (req) => {
    const p = auth(req, 'teams.run');
    const b = req.body as Body;
    return await m.teams.run(p, param(req), String(b.task ?? ''), { approve: b.approve as boolean | undefined, budget: b.budget ? Number(b.budget) : undefined });
  });

  // ---- workflows ------------------------------------------------------------
  app.get('/api/workflows', async (req) => (auth(req), { workflows: m.workflows.list(), templates: m.workflows.listTemplates() }));
  app.post('/api/workflows', async (req) => {
    const p = auth(req, 'workflow.run');
    const name = String((req.body as Body)?.name ?? '');
    // Workflows are shared: overwriting an existing (or bundled) one requires an admin.
    if (name && m.workflows.get(name) && p.role !== 'admin') throw new HttpError(403, `workflow "${name}" already exists; only an admin may overwrite it`);
    return m.workflows.save(req.body as never);
  });
  app.post('/api/workflows/:name/run', async (req, reply) => {
    const p = auth(req, 'workflow.run');
    const b = req.body as Body;
    const stream = sse(req, reply);
    const off = m.bus.on('*', (e: MercuryEvent) => {
      // Only this user's events (workflow events without a user id are global progress markers).
      if (e.userId === p.userId || (e.type.startsWith('workflow.') && !e.userId)) stream.send('event', e);
    });
    try {
      const r = await m.workflows.run(param(req, 'name'), String(b.input ?? ''), { principal: p, platform: 'web' });
      stream.send('done', r);
    } catch (err) {
      req.log.error({ err }, 'workflow run failed');
      stream.send('error', { error: publicError(err, 'the workflow failed; see server logs') });
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
  app.post('/api/schedules', async (req) => {
    const { p } = sched(req);
    const b = (req.body ?? {}) as Body;
    // '__…__' names/tasks are reserved for runtime-internal jobs (e.g. the proactive digest sentinel).
    if (p.role !== 'admin' && [b.name, b.task].some((v) => typeof v === 'string' && /^__\w+__$/.test(v.trim()))) throw new HttpError(403, 'reserved schedule name/task');
    if (typeof b.when !== 'string' || !b.when.trim() || typeof b.task !== 'string' || !b.task.trim()) throw new HttpError(400, '"when" and "task" are required strings');
    return m.scheduler.create(p.userId, req.body as never);
  });
  app.patch('/api/schedules/:id', async (req) => {
    const { p, owner } = sched(req);
    const b = (req.body ?? {}) as Body;
    if (p.role !== 'admin' && [b.name, b.task].some((v) => typeof v === 'string' && /^__\w+__$/.test(v.trim()))) throw new HttpError(403, 'reserved schedule name/task');
    return m.scheduler.update(param(req), req.body as never, owner);
  });
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
  app.get('/api/schedules/:id/history', async (req) => {
    const { owner } = sched(req);
    const s = m.scheduler.get(param(req));
    if (!s || (owner && s.userId !== owner)) throw new HttpError(404, 'schedule not found');
    return { runs: m.scheduler.history(param(req)) };
  });

  // ---- gateway ----------------------------------------------------------------
  app.get('/api/gateway', async (req) => {
    const p = auth(req);
    const admin = p.role === 'admin';
    return { enabled: m.config.gateway.enabled, adapters: m.gateway.status(), pairing: admin ? m.pairing.listPending() : [], review: admin ? m.gateway.reviewQueue() : [], identities: m.users.listIdentities(p.userId) };
  });
  app.post('/api/gateway/pair/:code', async (req) => {
    // Pairing grants an outside chat identity a full user principal → admin only (docs/SECURITY.md).
    const p = auth(req, 'gateway.manage');
    const b = req.body as Body;
    if (b.reject) return (m.pairing.reject(param(req, 'code'), p.userId), { ok: true });
    const target = b.userId ? String(b.userId) : p.userId;
    return m.pairing.approve(param(req, 'code'), target, p.userId, { relink: b.relink === true });
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
    const p = auth(req);
    // Task ids are run ids: non-admins only see the economics of their own runs.
    const tasks = m.taskBudgets.all().filter((t) => ownsRun(p, t.taskId)).map((t) => ({ ...t, costVsValue: m.taskBudgets.costVsValue(t.taskId) }));
    return { config: m.config.budgets.perTask, economics: m.config.router.economics, active: tasks.filter((t) => t.state === 'active'), tasks };
  });
  app.get('/api/tasks/:id', async (req) => {
    const p = auth(req);
    const budget = m.taskBudgets.get(param(req));
    if (!budget || !ownsRun(p, budget.taskId)) throw new HttpError(404, 'task not found');
    return { budget, costVsValue: m.taskBudgets.costVsValue(param(req)) };
  });

  // ---- reflections & decisions (Jev) ---------------------------------------------
  app.get('/api/reflections', async (req) => {
    const p = auth(req);
    return { reflections: m.reflector.list(p.role === 'admin' ? undefined : p.userId) };
  });
  app.get('/api/decisions', async (req) => {
    const p = auth(req);
    const purpose = (req.query as Body).purpose as string | undefined;
    // Decision history spans all users' runs → only admins see the individual records.
    return { chain: m.decisions.chain(), recent: p.role === 'admin' ? m.decisions.recent(100, purpose) : [], calibration: m.decisions.calibration(purpose), thresholds: m.config.decision.thresholds };
  });
  app.post('/api/decisions/try', async (req) => {
    // The playground can call the LLM decision provider as SYSTEM (budget-exempt) → admin only.
    auth(req, 'config.manage');
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
    if (!canSeeRun(p, param(req), events)) throw new HttpError(404, 'run not found');
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
  app.get('/api/debug', async (req) => {
    const p = auth(req, 'debug');
    return { breakpoints: m.debug.getGlobal(), paused: m.debug.list().filter((s) => ownsRun(p, s.runId)) };
  });
  app.post('/api/debug/breakpoints', async (req) => (auth(req, 'config.manage'), m.debug.setGlobal(req.body as never)));
  app.post('/api/debug/resume/:id', async (req) => {
    const p = auth(req, 'debug');
    // Resuming may inject edited messages/tool arguments: only the run's owner (or an admin) may do it.
    const step = m.debug.list().find((s) => s.id === param(req));
    if (!step || !ownsRun(p, step.runId)) throw new HttpError(404, 'paused step not found');
    return { ok: m.debug.resume(step.id, ((req.body as Body) ?? { action: 'continue' }) as never) };
  });
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
    if (!canSeeRun(p, param(req), events)) throw new HttpError(404, 'run not found');
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

  // ---- built-in verification: evidence-based completion checks + confidence + escalations ----
  app.get('/api/verifications', async (req) => {
    auth(req, 'audit.read');
    const taskId = (req.query as Body).taskId as string | undefined;
    return { enabled: m.config.verification.enabled, config: m.config.verification, verifications: m.verifier.list(taskId) };
  });
  app.get('/api/verifications/:id', async (req) => {
    auth(req, 'audit.read');
    const v = m.verifier.get(param(req));
    if (!v) throw new HttpError(404, 'verification not found');
    return v;
  });
  app.post('/api/verify', async (req) => {
    const p = auth(req);
    const b = req.body as Body;
    if (!Array.isArray(b.checks)) throw new HttpError(400, 'checks (array) is required');
    if (p.role !== 'admin') {
      // `test` checks run shell commands on the host, assertions touch the filesystem/network and
      // the critic spends SYSTEM LLM budget → only pure `schema` checks are available to non-admins.
      const bad = (b.checks as Array<{ type?: unknown }>).filter((c) => !c || c.type !== 'schema');
      if (bad.length) throw new HttpError(403, 'only admins may run test, assertion or critic checks');
      if (b.runId && !ownsRun(p, String(b.runId))) throw new HttpError(404, 'run not found');
      if (b.taskId && !ownsRun(p, String(b.taskId))) throw new HttpError(404, 'task not found');
    }
    return m.verifier.verify({
      taskId: b.taskId ? String(b.taskId) : undefined,
      runId: b.runId ? String(b.runId) : undefined,
      userId: p.userId,
      goal: b.goal ? String(b.goal) : undefined,
      output: b.output ? String(b.output) : undefined,
      result: b.result,
      checks: b.checks as never,
      threshold: b.threshold === undefined ? undefined : Number(b.threshold),
    });
  });
  app.get('/api/escalations', async (req) => {
    auth(req, 'audit.read');
    const status = ((req.query as Body).status as string) ?? 'open';
    return { escalations: m.verifier.escalations(status as never) };
  });
  app.post('/api/escalations/:id/resolve', async (req) => {
    auth(req, 'config.manage');
    return { resolved: m.verifier.resolveEscalation(param(req)) };
  });

  // ---- reliability engineering: SLOs, record/replay regression, chaos status -------------------
  app.get('/api/slo', async (req) => {
    auth(req, 'audit.read');
    const days = (req.query as Body).days;
    return m.slo.compute(days === undefined ? undefined : Number(days));
  });
  app.get('/api/chaos', async (req) => {
    auth(req, 'audit.read');
    return m.chaos.status();
  });
  app.get('/api/recordings', async (req) => {
    auth(req, 'audit.read');
    return { recordings: m.runRecorder.list() };
  });
  app.post('/api/recordings', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.runId) throw new HttpError(400, 'runId is required');
    const rec = m.runRecorder.record(String(b.runId), b.name ? String(b.name) : undefined);
    if (!rec) throw new HttpError(404, 'run not found');
    return rec;
  });
  app.post('/api/recordings/:id/replay', async (req) => {
    auth(req, 'config.manage');
    return m.replay.replay(param(req));
  });
  app.delete('/api/recordings/:id', async (req) => {
    auth(req, 'config.manage');
    return { removed: m.runRecorder.remove(param(req)) };
  });

  // ---- proactive: event triggers, interrupt-vs-defer priority, digest queue ---------------------
  app.get('/api/proactive', async (req) => {
    auth(req, 'audit.read');
    const pc = m.config.proactive;
    return {
      enabled: pc.enabled,
      config: { interruptThreshold: pc.interruptThreshold, digestCron: pc.digestCron },
      sources: m.proactive.sourceNames(),
      rules: m.proactive.rules(),
      events: m.proactive.events(),
      digest: m.proactive.deferred(),
    };
  });
  app.post('/api/proactive/events', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.source || !b.kind) throw new HttpError(400, 'source and kind are required');
    return m.proactive.ingest({ source: String(b.source), kind: String(b.kind), title: b.title ? String(b.title) : undefined, body: b.body ? String(b.body) : undefined });
  });
  app.post('/api/proactive/digest/flush', async (req) => {
    auth(req, 'config.manage');
    return m.proactive.flushDigest();
  });
  app.post('/api/proactive/poll', async (req) => {
    auth(req, 'config.manage');
    return m.proactive.poll();
  });

  // ---- learning: experience hints, auto-tuned routing stats, failure playbooks ------------------
  app.get('/api/learning', async (req) => {
    auth(req, 'audit.read');
    const lc = m.config.learning;
    return {
      enabled: lc.enabled,
      config: { hints: lc.hints.enabled, routing: lc.routing.enabled, playbooks: lc.playbooks.enabled },
      routeStats: m.learning.routeStats(),
      playbooks: m.learning.playbooks(100),
    };
  });
  app.get('/api/learning/stats', async (req) => {
    auth(req, 'audit.read');
    const bucket = (req.query as Body).bucket as string | undefined;
    return { stats: m.learning.routeStats(bucket) };
  });
  app.get('/api/learning/playbooks', async (req) => {
    auth(req, 'audit.read');
    const limit = (req.query as Body).limit;
    return { playbooks: m.learning.playbooks(limit === undefined ? 100 : Number(limit)) };
  });
  app.get('/api/learning/hint', async (req) => {
    const p = auth(req);
    const task = (req.query as Body).task as string | undefined;
    if (!task) throw new HttpError(400, 'task is required');
    return { hint: m.learning.hintFor(task, p.userId) ?? null };
  });

  // ---- distilled skills: reusable parameterized skills distilled from winning run traces --------
  app.get('/api/distilled-skills', async (req) => {
    auth(req, 'audit.read');
    const dc = m.config.skills.distill;
    const status = (req.query as Body).status as string | undefined;
    return {
      enabled: dc.enabled,
      config: {
        autoApprove: dc.autoApprove,
        matchMinSimilarity: dc.matchMinSimilarity,
        dedupMinSimilarity: dc.dedupMinSimilarity,
        minRunsBeforeRetire: dc.minRunsBeforeRetire,
        retireBelowSuccessRate: dc.retireBelowSuccessRate,
      },
      skills: m.distiller.list(status as never),
    };
  });
  app.get('/api/distilled-skills/:id', async (req) => {
    auth(req, 'audit.read');
    const skill = m.distiller.get(param(req));
    if (!skill) throw new HttpError(404, 'skill not found');
    return skill;
  });
  app.post('/api/distilled-skills/:id/approve', async (req) => {
    auth(req, 'config.manage');
    const skill = m.distiller.approve(param(req));
    if (!skill) throw new HttpError(404, 'skill not found');
    return skill;
  });
  app.post('/api/distilled-skills/:id/retire', async (req) => {
    auth(req, 'config.manage');
    const skill = m.distiller.retire(param(req));
    if (!skill) throw new HttpError(404, 'skill not found');
    return skill;
  });
  app.post('/api/distilled-skills/distill', async (req) => {
    auth(req, 'config.manage');
    const runId = (req.body as Body).runId as string | undefined;
    if (!runId) throw new HttpError(400, 'runId is required');
    const skill = m.distiller.distillFromRun(runId, { force: true });
    if (!skill) throw new HttpError(422, 'run not eligible for distillation');
    return skill;
  });
  app.get('/api/distilled-skills/match/preview', async (req) => {
    auth(req, 'audit.read');
    const task = (req.query as Body).task as string | undefined;
    if (!task) throw new HttpError(400, 'task is required');
    return { match: m.distiller.match(task) ?? null };
  });

  // ---- evals: evaluation-driven self-improvement (closed evals + governed auto-tune) -----------
  app.get('/api/evals', async (req) => {
    auth(req, 'audit.read');
    const ec = m.config.evals;
    return {
      enabled: ec.enabled,
      config: {
        retainScores: ec.retainScores,
        weights: ec.weights,
        costCeiling: ec.costCeiling,
        autotune: ec.autotune,
      },
      suites: m.evals.listSuites(),
    };
  });
  app.get('/api/evals/suites/:id', async (req) => {
    auth(req, 'audit.read');
    const suite = m.evals.getSuite(param(req));
    if (!suite) throw new HttpError(404, 'suite not found');
    return { suite, cases: m.evals.listCases(suite.id), trend: m.evals.trend(suite.id) };
  });
  app.post('/api/evals/suites', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.name) throw new HttpError(400, 'name is required');
    return m.evals.createSuite(String(b.name), (b.agent as string) ?? 'default', (b.description as string) ?? '');
  });
  app.post('/api/evals/cases', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.suiteId || !b.name || !b.input) throw new HttpError(400, 'suiteId, name and input are required');
    try {
      return m.evals.addCase({
        suiteId: String(b.suiteId),
        name: String(b.name),
        input: String(b.input),
        expected: b.expected as never,
        tags: b.tags as string[] | undefined,
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.delete('/api/evals/cases/:id', async (req) => (auth(req, 'config.manage'), { removed: m.evals.removeCase(param(req)) }));
  app.post('/api/evals/promote', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.runId) throw new HttpError(400, 'runId is required');
    try {
      return m.evals.promoteRun(String(b.runId), {
        suiteId: b.suiteId as string | undefined,
        suiteName: b.suiteName as string | undefined,
        name: b.name as string | undefined,
        expected: b.expected as never,
        tags: b.tags as string[] | undefined,
      });
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
  });
  app.post('/api/evals/suites/:id/run', async (req) => {
    auth(req, 'config.manage');
    if (!m.evals.getSuite(param(req))) throw new HttpError(404, 'suite not found');
    const b = (req.body as Body) ?? {};
    return m.evals.runSuite(param(req), { label: b.label as string | undefined });
  });
  app.get('/api/evals/suites/:id/trend', async (req) => (auth(req, 'audit.read'), { scores: m.evals.trend(param(req)) }));
  app.post('/api/evals/suites/:id/tune', async (req) => {
    auth(req, 'config.manage');
    if (!m.evals.getSuite(param(req))) throw new HttpError(404, 'suite not found');
    const b = (req.body as Body) ?? {};
    return m.evals.proposeTune(param(req), b.proposals as never);
  });
  app.post('/api/evals/suites/:id/apply-tune', async (req) => {
    auth(req, 'config.manage');
    if (!m.evals.getSuite(param(req))) throw new HttpError(404, 'suite not found');
    const b = req.body as Body;
    if (!b || typeof b !== 'object') throw new HttpError(400, 'a tune evaluation is required');
    try {
      return m.evals.applyTune(param(req), b as never);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.get('/api/evals/tunes', async (req) => {
    auth(req, 'audit.read');
    return { tunes: m.evals.listTunes((req.query as Body).suiteId as string | undefined) };
  });
  app.post('/api/evals/tunes/:id/revert', async (req) => {
    auth(req, 'config.manage');
    try {
      return m.evals.revertTune(param(req));
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  // ---- bundles: sharable agent bundles ("Mercury packs") — export/sign/inspect/install ----------
  app.get('/api/bundles', async (req) => {
    auth(req, 'audit.read');
    const bc = m.config.bundles;
    return {
      enabled: bc.enabled,
      config: { requireSignature: bc.requireSignature, autoApprovePolicy: bc.autoApprovePolicy, autoApproveMcp: bc.autoApproveMcp },
      installed: m.bundles.list(),
    };
  });
  app.post('/api/bundles/export', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    if (!b.name) throw new HttpError(400, 'name is required');
    return m.bundles.export({
      name: String(b.name),
      version: b.version as string | undefined,
      sections: b.sections as never,
      description: b.description as string | undefined,
      author: b.author as string | undefined,
    });
  });
  app.post('/api/bundles/inspect', async (req) => {
    auth(req, 'audit.read');
    const b = req.body as Body;
    if (!b || !b.manifest) throw new HttpError(400, 'a bundle is required');
    return m.bundles.inspect(b as never);
  });
  app.post('/api/bundles/install', async (req) => {
    auth(req, 'config.manage');
    const b = req.body as Body;
    const bundle = (b.bundle ?? b) as Body;
    if (!bundle || !bundle.manifest) throw new HttpError(400, 'a bundle is required');
    return m.bundles.install(bundle as never, { source: b.source as string | undefined });
  });
  app.post('/api/bundles/:id/approve', async (req) => {
    auth(req, 'config.manage');
    const b = (req.body as Body) ?? {};
    const rec = m.bundles.approvePending(param(req), b.sections as never, b.bundle as never);
    if (!rec) throw new HttpError(404, 'install record not found');
    return rec;
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
