/** Core routes: health, auth, users, tokens, chat (SSE), sessions, attachments, voice, approvals. */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { SCOPES, type Attachment, type MercuryEvent } from '@mercury/core';
import { HttpError, type Ctx } from '../http.js';

type Body = Record<string, unknown>;
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  return v;
};

/** Events forwarded to the chat stream for the runs a request started (incl. subagents). */
const STREAM_EVENTS = new Set(['run.start', 'run.end', 'tool.call', 'tool.result', 'tool.denied', 'approval.request', 'approval.resolved', 'subagent.spawn', 'subagent.end', 'decision', 'guardrail', 'thought', 'debug.paused']);

export function registerCoreRoutes(app: FastifyInstance, { m, auth, sse }: Ctx): void {
  app.get('/health', async () => ({ ok: true, version: '0.2.0', uptimeSec: Math.round((Date.now() - m.startedAt.getTime()) / 1000) }));

  // ---- auth ---------------------------------------------------------------
  app.get('/api/auth/status', async () => ({ users: m.users.count(), allowRegistration: m.config.auth.allowRegistration || m.users.count() === 0 }));
  app.post('/api/auth/register', async (req) => {
    const b = req.body as Body;
    if (!m.config.auth.allowRegistration && m.users.count() > 0) throw new HttpError(403, 'registration is disabled; ask an admin');
    const user = m.users.register(str(b.username, 'username'), str(b.password, 'password'), { displayName: b.displayName as string | undefined });
    return { token: m.users.issueJwt(user), user };
  });
  app.post('/api/auth/login', async (req) => {
    const b = req.body as Body;
    return m.users.login(str(b.username, 'username'), str(b.password, 'password'));
  });
  app.get('/api/auth/me', async (req) => {
    const p = auth(req);
    return { principal: p, user: m.users.get(p.userId), identities: m.users.listIdentities(p.userId) };
  });
  app.patch('/api/auth/me', async (req) => {
    const p = auth(req);
    const b = req.body as Body;
    if (typeof b.password === 'string') m.users.setPassword(p.userId, b.password);
    return m.users.update(p.userId, { displayName: b.displayName as string | undefined, locale: b.locale as string | undefined });
  });

  // ---- API tokens ---------------------------------------------------------
  app.get('/api/tokens', async (req) => ({ tokens: m.users.listTokens(auth(req).userId), scopes: SCOPES }));
  app.post('/api/tokens', async (req) => {
    const p = auth(req);
    if (p.kind === 'api_client') throw new HttpError(403, 'API tokens cannot mint tokens');
    const b = req.body as Body;
    return m.users.createToken(p.userId, str(b.name, 'name'), (b.scopes as string[] | undefined) ?? ['chat'], b.ttlDays as number | undefined);
  });
  app.delete('/api/tokens/:id', async (req) => {
    const p = auth(req);
    const id = (req.params as Body).id as string;
    if (!m.users.listTokens(p.userId).some((t) => t.id === id) && p.role !== 'admin') throw new HttpError(404, 'token not found');
    m.users.revokeToken(id, p.userId);
    return { ok: true };
  });

  // ---- users (admin) --------------------------------------------------------
  app.get('/api/users', async (req) => (auth(req, 'users.manage'), { users: m.users.list() }));
  app.post('/api/users', async (req) => {
    const p = auth(req, 'users.manage');
    const b = req.body as Body;
    return m.users.register(str(b.username, 'username'), str(b.password, 'password'), { role: (b.role as 'user' | 'admin') ?? 'user' }, p.userId);
  });
  app.patch('/api/users/:id', async (req) => {
    const p = auth(req, 'users.manage');
    const b = req.body as Body;
    const id = (req.params as Body).id as string;
    return m.users.update(id, { role: b.role as 'user' | 'admin' | undefined, disabled: b.disabled as boolean | undefined, policy: b.policy as never }, p.userId);
  });
  app.delete('/api/users/:id', async (req) => {
    const p = auth(req, 'users.manage');
    const id = (req.params as Body).id as string;
    if (id === p.userId) throw new HttpError(400, 'cannot delete yourself');
    m.users.delete(id, p.userId);
    return { ok: true };
  });

  // ---- chat -------------------------------------------------------------------
  app.get('/api/commands', async (req) => (auth(req), { commands: m.commands.list() }));
  app.post('/api/chat', async (req, reply) => {
    const p = auth(req, 'chat');
    const b = req.body as Body;
    const input = str(b.message, 'message');
    const attachments: Attachment[] = [];
    for (const id of (b.attachments as string[] | undefined) ?? []) {
      const att = m.attachments.get(id);
      if (!att || m.attachments.owner(id) !== p.userId) throw new HttpError(404, `attachment ${id} not found`);
      attachments.push(await m.attachments.process(att));
    }
    const opts = { principal: p, input, platform: 'web', sessionId: b.sessionId as string | undefined, model: b.model as string | undefined, pattern: b.pattern as string | undefined, personality: b.personality as string | undefined, attachments };
    if (!b.stream) return m.commands.handle(opts);

    const stream = sse(req, reply);
    const runs = new Set<string>();
    const off = m.bus.on('*', (e: MercuryEvent) => {
      if (e.type === 'run.start' && e.userId === p.userId && (!e.data.parentRunId || runs.has(String(e.data.parentRunId)))) runs.add(e.runId!);
      if (e.runId && runs.has(e.runId) && STREAM_EVENTS.has(e.type)) stream.send('event', e);
    });
    const controller = new AbortController();
    stream.onClose(() => {
      off();
      controller.abort();
    });
    try {
      const r = await m.commands.handle({ ...opts, signal: controller.signal, onDelta: (text: string) => stream.send('delta', { text }) });
      stream.send('done', { output: r.output, sessionId: r.sessionId, command: r.command, runId: r.run?.runId, status: r.run?.status, usage: r.run?.usage, model: r.run?.model, pattern: r.run?.pattern, data: r.data });
    } catch (err) {
      stream.send('error', { error: (err as Error).message });
    } finally {
      off();
      stream.end();
    }
  });
  app.post('/api/runs/:id/stop', async (req) => ({ stopped: m.agent.stop((req.params as Body).id as string) }));
  app.post('/api/runs/:id/feedback', async (req) => {
    auth(req);
    const runId = (req.params as Body).id as string;
    const positive = Boolean((req.body as Body).positive);
    const updated = m.reflector.feedback(runId, positive);
    // Self-distilling skills: a 👍 marks this run as a winning path worth distilling.
    let distilled: string | undefined;
    if (positive && m.config.skills.distill.enabled) {
      try {
        distilled = m.distiller.onFeedback(runId, true)?.id;
      } catch {
        /* distillation must never break feedback */
      }
    }
    return { updated, distilled };
  });

  // ---- deterministic run replay & time-travel debugging -----------------------
  // Full ordered trace for a run (steps + metadata + fork lineage). Distinct from the plain
  // audit-trail /api/runs/:id/trace — this view carries time-travel metadata and fork lineage.
  app.get('/api/runs/:id/timetravel', async (req) => {
    auth(req);
    if (!m.config.replay.enabled) throw new HttpError(404, 'run replay is disabled');
    const trace = m.traces.getTrace((req.params as Body).id as string);
    if (!trace) throw new HttpError(404, 'no trace for this run');
    return trace;
  });
  // Reconstructed accumulated state at a given step (scrub/time-travel inspection).
  app.get('/api/runs/:id/state', async (req) => {
    auth(req);
    if (!m.config.replay.enabled) throw new HttpError(404, 'run replay is disabled');
    const step = Number((req.query as Body).step ?? 0) || 0;
    const state = m.traces.getStateAt((req.params as Body).id as string, step);
    if (!state) throw new HttpError(404, 'no trace for this run');
    return state;
  });
  // Recently traced runs (run viewer list).
  app.get('/api/traces', async (req) => {
    const p = auth(req);
    if (!m.config.replay.enabled) throw new HttpError(404, 'run replay is disabled');
    return { traces: m.traces.listTraces(p.userId, Number((req.query as Body).limit ?? 50) || 50) };
  });
  // Fork a run from a chosen step with edited inputs → a new linked run (recomputes downstream).
  app.post('/api/runs/:id/replay', async (req) => {
    const p = auth(req);
    if (!m.config.replay.enabled) throw new HttpError(404, 'run replay is disabled');
    const b = req.body as Body;
    const result = await m.traces.replayFrom((req.params as Body).id as string, {
      fromStep: b.fromStep !== undefined ? Number(b.fromStep) : undefined,
      edits: (b.edits as Record<string, unknown>) ?? undefined,
      userId: p.userId,
    });
    if (!result) throw new HttpError(404, 'run replay is disabled');
    return result;
  });

  // ---- sessions ---------------------------------------------------------------
  app.get('/api/sessions', async (req) => {
    const p = auth(req, 'memory.read');
    const q = (req.query as Body).q as string | undefined;
    if (q) return m.memory.searchSessions(p.userId, q, { limit: 20, summarize: false });
    return { sessions: m.db.all('SELECT id, title, platform, model, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200', p.userId) };
  });
  app.get('/api/sessions/:id', async (req) => {
    const p = auth(req, 'memory.read');
    const id = (req.params as Body).id as string;
    const session = m.db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', id, p.userId);
    if (!session) throw new HttpError(404, 'session not found');
    const messages = m.db.all("SELECT id, role, content, name, attachments, run_id, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY seq", id);
    return { session, messages };
  });
  app.patch('/api/sessions/:id', async (req) => {
    const p = auth(req, 'memory.write');
    m.db.run('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?', String((req.body as Body).title ?? ''), (req.params as Body).id as string, p.userId);
    return { ok: true };
  });
  app.delete('/api/sessions/:id', async (req) => {
    const p = auth(req, 'memory.write');
    const id = (req.params as Body).id as string;
    m.db.run('DELETE FROM messages WHERE session_id = ? AND user_id = ?', id, p.userId);
    m.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, p.userId);
    return { ok: true };
  });

  // ---- attachments & voice ----------------------------------------------------
  app.post('/api/attachments', async (req) => {
    const p = auth(req, 'chat');
    const name = String((req.query as Body).name ?? 'upload.bin').replace(/[^\w.\- ]/g, '_');
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    if (!data.length) throw new HttpError(400, 'empty upload');
    return m.attachments.save(p.userId, name, data, req.headers['content-type']);
  });
  app.get('/api/attachments/:id', async (req, reply) => {
    const p = auth(req);
    const att = m.attachments.get((req.params as Body).id as string);
    if (!att?.path || (m.attachments.owner(att.id) !== p.userId && p.role !== 'admin')) throw new HttpError(404, 'not found');
    return reply.type(att.mime).send(readFileSync(att.path));
  });
  app.post('/api/voice/speak', async (req, reply) => {
    auth(req, 'chat');
    const r = await m.voice.speak(str((req.body as Body).text, 'text'));
    return reply.type(r.mime).send(readFileSync(r.path));
  });
  app.post('/api/voice/transcribe', async (req) => {
    const p = auth(req, 'chat');
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const att = await m.attachments.save(p.userId, 'recording.webm', data, req.headers['content-type']);
    return { text: await m.voice.transcribe(att.path!, att.mime), attachment: att };
  });

  // ---- approvals --------------------------------------------------------------
  app.get('/api/approvals', async (req) => {
    const p = auth(req);
    return { approvals: m.approvals.list(p.role === 'admin' ? undefined : p.userId) };
  });
  app.post('/api/approvals/:id', async (req) => {
    auth(req);
    return { ok: m.approvals.resolve((req.params as Body).id as string, Boolean((req.body as Body).approved)) };
  });
}
