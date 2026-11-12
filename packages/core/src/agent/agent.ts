/**
 * Agent — runs one turn of a conversation end to end:
 *
 *   resolve session → input guardrails → expand @references → process attachments
 *   → build system prompt (persona, context files, skills index, memory) → pick pattern
 *   (explicit / session / decision engine / config) → pattern.run(loop, complete)
 *   → output guardrails → persist messages → run record → reflection (async)
 *
 * The same Agent serves the CLI, web UI, gateway, scheduler, MCP server and subagents.
 */
import type { MercuryConfig } from '../config/schema.js';
import type { Db } from '../db/db.js';
import { toJson } from '../db/db.js';
import type { Judgment } from '../decision/judgment.js';
import type { EventBus } from '../events/bus.js';
import type { LLMService } from '../llm/service.js';
import type { MemoryManager } from '../memory/manager.js';
import type { HookManager } from '../plugins/hooks.js';
import type { Reflector, Reflection } from '../reflection/reflector.js';
import type { PathJail } from '../security/paths.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ApprovalService } from '../tools/approvals.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolServices } from '../tools/services.js';
import type { ToolContext } from '../tools/types.js';
import type { AttachmentStore } from '../attachments/store.js';
import { MercuryError, errorMessage, extractJson, newId, nowIso, type Principal } from '../types/common.js';
import type { Attachment, ChatMessage, DeltaHandler, TrustLevel } from '../types/messages.js';
import { discoverContextFiles, renderContextFiles } from './context-files.js';
import type { Breakpoints, DebugController } from './debug.js';
import type { Guardrails } from './guardrails.js';
import { runToolLoop, RunStoppedError, type LoopDeps } from './loop.js';
import type { PatternRegistry } from './patterns/index.js';
import type { PatternContext } from './patterns/types.js';
import type { Personalities } from './personalities.js';
import { buildSystemPrompt } from './prompt.js';
import { expandReferences } from './references.js';
import { RunState, type RunUsage } from './run-state.js';

export interface AgentDeps {
  config: MercuryConfig;
  db: Db;
  bus: EventBus;
  hooks: HookManager;
  llm: LLMService;
  tools: ToolRegistry;
  executor: ToolExecutor;
  memory: MemoryManager;
  skills: SkillRegistry;
  judgment: Judgment;
  approvals: ApprovalService;
  debug: DebugController;
  guardrails: Guardrails;
  personalities: Personalities;
  patterns: PatternRegistry;
  jail: PathJail;
  attachments: AttachmentStore;
  services: ToolServices;
  reflector?: Reflector;
}

export interface RunOptions {
  principal: Principal;
  input: string;
  attachments?: Attachment[];
  sessionId?: string;
  /** cli | web | telegram | ... | scheduler | mcp | subagent */
  platform?: string;
  /** Platform chat id (gateway) used as default delivery target. */
  chatId?: string;
  model?: string;
  /** Pattern name or "auto" (decision engine picks). */
  pattern?: string;
  personality?: string;
  /** Restrict available toolsets (subagents, scheduled jobs). */
  toolsets?: string[];
  depth?: number;
  parentRunId?: string;
  signal?: AbortSignal;
  onDelta?: DeltaHandler;
  /** Trust of the input itself: 'user' for authenticated users, 'untrusted' for mail/webhooks/strangers. */
  trust?: TrustLevel;
  /** Do not persist to a session (subagents, workflow workers). */
  ephemeral?: boolean;
  systemExtra?: string;
  maxIterations?: number;
  workdir?: string;
  kind?: 'chat' | 'subagent' | 'workflow' | 'schedule' | 'mcp';
  /** Run reflection after the turn (default: config.reflection.enabled && depth 0). */
  reflect?: boolean;
  debug?: Partial<Breakpoints>;
}

export interface RunResult {
  runId: string;
  sessionId: string;
  output: string;
  status: 'completed' | 'stopped' | 'blocked' | 'error';
  pattern: string;
  model?: string;
  toolCalls: number;
  toolNames: string[];
  usage: RunUsage;
  error?: string;
  reflection?: Promise<Reflection | undefined>;
}

export class Agent {
  private active = new Map<string, { controller: AbortController; sessionId: string; userId: string }>();
  private pendingReflections = new Set<Promise<unknown>>();

  constructor(readonly deps: AgentDeps) {}

  /** Abort a running turn by run id or session id. Returns the number of runs stopped. */
  stop(idOrSession: string): number {
    let n = 0;
    for (const [runId, r] of this.active) {
      if (runId === idOrSession || r.sessionId === idOrSession) {
        r.controller.abort();
        this.deps.approvals.cancelRun(runId);
        n++;
      }
    }
    return n;
  }

  activeRuns(userId?: string): Array<{ runId: string; sessionId: string; userId: string }> {
    return [...this.active.entries()].filter(([, r]) => !userId || r.userId === userId).map(([runId, r]) => ({ runId, sessionId: r.sessionId, userId: r.userId }));
  }

  /** Wait until background reflections have finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pendingReflections]);
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const d = this.deps;
    const runId = newId('run');
    const platform = opts.platform ?? 'cli';
    const depth = opts.depth ?? 0;
    const controller = new AbortController();
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    // ---- session -------------------------------------------------------------------
    const session = opts.ephemeral
      ? { id: opts.sessionId ?? `eph_${runId}`, model: undefined, pattern: undefined, personality: undefined }
      : (opts.sessionId && d.memory.episodic.getSession(opts.sessionId)) ||
        d.memory.episodic.createSession(opts.principal.userId, { id: opts.sessionId, title: opts.input.slice(0, 60) || 'New chat', platform });
    if (!opts.ephemeral && 'userId' in session && session.userId !== opts.principal.userId && opts.principal.role !== 'admin') {
      throw new MercuryError('This session belongs to another user', 'forbidden', 'auth', 403);
    }
    const sessionId = session.id;
    const model = opts.model ?? session.model ?? (d.config.llm.defaultModel === 'auto' ? undefined : d.config.llm.defaultModel);

    this.active.set(runId, { controller, sessionId, userId: opts.principal.userId });
    d.debug.setForRun(runId, opts.debug ?? {});
    d.db.run(
      'INSERT INTO runs (id, user_id, session_id, parent_run_id, kind, status, input, model, depth, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      runId, opts.principal.userId, sessionId, opts.parentRunId, opts.kind ?? (depth ? 'subagent' : 'chat'), 'running', opts.input.slice(0, 10_000), model, depth, nowIso(),
    );
    d.bus.emit({ type: 'run.start', runId, sessionId, userId: opts.principal.userId, data: { input: opts.input.slice(0, 2000), platform, depth, parentRunId: opts.parentRunId } });
    await d.hooks.run('run_start', { runId, sessionId, principal: opts.principal, input: opts.input, platform });

    const workdir = opts.workdir ?? d.config.tools.jail.roots[0] ?? process.cwd();
    const security = { untrustedSeen: opts.trust === 'untrusted', userRequest: opts.input };
    const toolCtx: ToolContext = {
      principal: opts.principal,
      runId,
      sessionId,
      platform,
      chatId: opts.chatId,
      signal: controller.signal,
      workdir,
      depth,
      allowedToolsets: opts.toolsets,
      services: d.services,
      emit: (type, data) => d.bus.emit({ type, runId, sessionId, userId: opts.principal.userId, data }),
      requestApproval: (req) => d.approvals.request(req, { runId, userId: opts.principal.userId, platform }),
    };
    const run = new RunState(runId, sessionId, opts.principal, platform, depth, controller, toolCtx, security, model, opts.toolsets, opts.onDelta);

    let patternName = 'react';
    try {
      // ---- input guardrail ---------------------------------------------------------
      const verdict = await d.guardrails.checkInput(opts.input, opts.trust ?? 'user', runId);
      if (verdict.blocked) {
        const output = 'This message was blocked by Mercury\'s prompt-injection guard. (help: security)';
        return this.finish(run, opts, { output, status: 'blocked', pattern: 'none', userMsg: { role: 'user', content: opts.input, untrusted: true } });
      }

      // ---- references + attachments -------------------------------------------------
      const refs = await expandReferences(opts.input, { workdir, jail: d.jail, allowPrivateNetworks: d.config.tools.web.allowPrivateNetworks });
      if (refs.untrusted) security.untrustedSeen = true;
      const attachments = await Promise.all((opts.attachments ?? []).map((a) => (a.data || a.transcript ? a : d.attachments.process(a))));
      if (attachments.length) security.untrustedSeen = security.untrustedSeen || attachments.some((a) => a.kind !== 'image');
      const userContent = opts.trust === 'untrusted' ? `<untrusted_content source="${platform}">\n${refs.text}\n</untrusted_content>` : refs.text;
      const userMsg: ChatMessage = { role: 'user', content: userContent, attachments: attachments.length ? attachments : undefined, untrusted: opts.trust === 'untrusted' };

      // ---- prompt ----------------------------------------------------------------------
      const history = opts.ephemeral ? [] : d.memory.episodic.messages(sessionId, 200).map(stripStored);
      const system = await this.systemPrompt(opts, run, workdir, history.length);
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, userMsg];

      // ---- pattern -----------------------------------------------------------------------
      patternName = await this.choosePattern(opts, session.pattern, runId);
      const pattern = d.patterns.get(patternName) ?? d.patterns.get('react')!;
      d.bus.emit({ type: 'pattern', runId, data: { pattern: pattern.name } });
      const ctx = this.patternContext(run, opts, messages);
      const result = await pattern.run(ctx);

      // ---- output guardrail ----------------------------------------------------------------
      const out = d.guardrails.checkOutput(result.output, runId);
      const hook = await d.hooks.run('output', { runId, output: out.text, principal: opts.principal });
      const output = typeof hook.output === 'string' ? hook.output : out.text;
      const newMessages = result.newMessages.map((m, i) => (i === result.newMessages.length - 1 && m.role === 'assistant' ? { ...m, content: output } : m));
      return this.finish(run, opts, { output, status: 'completed', pattern: pattern.name, userMsg, newMessages });
    } catch (err) {
      const stopped = err instanceof RunStoppedError || controller.signal.aborted;
      const output = stopped ? '(stopped)' : `Error: ${errorMessage(err)}${err instanceof MercuryError && err.helpTopic ? ` (help: ${err.helpTopic})` : ''}`;
      await d.hooks.run('error', { runId, error: errorMessage(err) });
      return this.finish(run, opts, { output, status: stopped ? 'stopped' : 'error', pattern: patternName, userMsg: { role: 'user', content: opts.input }, error: stopped ? undefined : errorMessage(err) });
    }
  }

  /** Persist, record, emit and schedule reflection. Always called exactly once per run. */
  private async finish(
    run: RunState,
    opts: RunOptions,
    r: { output: string; status: RunResult['status']; pattern: string; userMsg: ChatMessage; newMessages?: ChatMessage[]; error?: string },
  ): Promise<RunResult> {
    const d = this.deps;
    if (!opts.ephemeral) {
      d.memory.episodic.append(run.sessionId, run.principal.userId, { ...r.userMsg, attachments: r.userMsg.attachments }, run.runId);
      const msgs = r.newMessages?.length ? r.newMessages : [{ role: 'assistant' as const, content: r.output }];
      for (const m of msgs) d.memory.episodic.append(run.sessionId, run.principal.userId, m, run.runId);
    }
    d.db.run('UPDATE runs SET status=?, output=?, model=?, pattern=?, ended_at=? WHERE id=?', r.status, r.output.slice(0, 20_000), run.lastModel ?? run.model, r.pattern, nowIso(), run.runId);
    d.bus.emit({ type: 'run.end', runId: run.runId, sessionId: run.sessionId, userId: run.principal.userId, data: { status: r.status, output: r.output.slice(0, 2000), usage: run.usage, toolCalls: run.toolCalls, pattern: r.pattern, error: r.error } });
    await d.hooks.run('run_end', { runId: run.runId, status: r.status, output: r.output });
    this.active.delete(run.runId);
    d.debug.clearRun(run.runId);

    const result: RunResult = { runId: run.runId, sessionId: run.sessionId, output: r.output, status: r.status, pattern: r.pattern, model: run.lastModel ?? run.model, toolCalls: run.toolCalls, toolNames: run.toolNames, usage: run.usage, error: r.error };
    const shouldReflect = (opts.reflect ?? (d.config.reflection.enabled && run.depth === 0)) && r.status === 'completed' && !!d.reflector;
    if (shouldReflect) {
      const p = d
        .reflector!.reflect({ runId: run.runId, sessionId: run.sessionId, principal: run.principal, task: opts.input, output: r.output, toolNames: run.toolNames, skillsUsed: [...run.skillsUsed] })
        .catch(() => undefined);
      this.pendingReflections.add(p);
      void p.finally(() => this.pendingReflections.delete(p));
      result.reflection = p;
    }
    return result;
  }

  private async systemPrompt(opts: RunOptions, run: RunState, workdir: string, historyLength: number): Promise<string> {
    const d = this.deps;
    const ctxFiles = run.depth === 0 ? renderContextFiles(discoverContextFiles(workdir)) : { instructions: '' };
    const persona = ctxFiles.soul ?? d.personalities.get(opts.personality ?? d.config.agent.personality).prompt;
    const memory = run.depth === 0 ? await d.memory.buildContext(run.principal.userId, run.sessionId, opts.input) : '';
    const turns = Math.floor(historyLength / 2) + 1;
    const nudge =
      run.depth === 0 && d.config.agent.nudgeEvery > 0 && turns % d.config.agent.nudgeEvery === 0
        ? '## Reminder\nBefore answering, consider whether anything from this conversation should be saved (the memory tool for durable facts/preferences, skill_manage for a reusable procedure).'
        : '';
    return buildSystemPrompt({
      persona,
      canary: d.guardrails.canary,
      platform: run.platform,
      workdir,
      userName: run.principal.username,
      contextFiles: ctxFiles.instructions,
      skillsIndex: d.skills.index(run.platform),
      memory,
      extra: [opts.systemExtra, nudge].filter(Boolean).join('\n\n'),
      depth: run.depth,
      textOnlyPlatform: !['cli', 'web'].includes(run.platform),
    });
  }

  private async choosePattern(opts: RunOptions, sessionPattern: string | undefined, runId: string): Promise<string> {
    const d = this.deps;
    const requested = opts.pattern ?? sessionPattern ?? d.config.agent.pattern;
    if (requested !== 'auto') return d.patterns.get(requested) ? requested : 'react';
    const picked = await d.judgment.selectPattern(opts.input, d.patterns.descriptions(), runId);
    return picked && d.patterns.get(picked) ? picked : 'react';
  }

  private patternContext(run: RunState, opts: RunOptions, messages: ChatMessage[]): PatternContext {
    const d = this.deps;
    const loopDeps: LoopDeps = {
      config: d.config,
      llm: d.llm,
      tools: d.tools,
      executor: d.executor,
      debug: d.debug,
      bus: d.bus,
      summarize: async (r, transcript) => {
        const res = await d.llm.complete(r.principal, [
          { role: 'system', content: 'Summarise this conversation excerpt for your own future reference: key facts, decisions, open tasks, user preferences. Be concise. Return JSON {"summary": "..."}' },
          { role: 'user', content: transcript.slice(0, 30_000) },
        ], { responseFormat: 'json', kind: 'summary', runId: r.runId });
        return extractJson<{ summary?: string }>(res.content)?.summary ?? res.content;
      },
    };
    return {
      task: opts.input,
      messages,
      runId: run.runId,
      principal: run.principal,
      signal: run.signal,
      judgment: d.judgment,
      onDelta: run.onDelta,
      emit: (type, data) => d.bus.emit({ type, runId: run.runId, sessionId: run.sessionId, data }),
      loop: (msgs, o) => runToolLoop(loopDeps, run, msgs, { maxIterations: opts.maxIterations, ...o }),
      complete: async (msgs, o = {}) => {
        if (run.signal.aborted) throw new RunStoppedError();
        const res = await d.llm.chat({
          principal: run.principal,
          messages: msgs,
          model: run.model,
          responseFormat: o.json ? 'json' : 'text',
          temperature: o.temperature,
          maxTokens: o.maxTokens,
          onDelta: o.stream ? run.onDelta : undefined,
          signal: run.signal,
          runId: run.runId,
          sessionId: run.sessionId,
        });
        run.addUsage(res);
        return res.content;
      },
    };
  }

  /** Force-compress a session's history (/compress). */
  async compressSession(principal: Principal, sessionId: string): Promise<{ before: number; after: number }> {
    const { compressMessages } = await import('./compression.js');
    const d = this.deps;
    const msgs = d.memory.episodic.messages(sessionId, 1000).map(stripStored);
    const out = await compressMessages(msgs, d.config.agent.compression.keepLast, async (t) => {
      const res = await d.llm.complete(principal, [
        { role: 'system', content: 'Summarise this conversation: key facts, decisions, open tasks. Return JSON {"summary": "..."}' },
        { role: 'user', content: t.slice(0, 30_000) },
      ], { responseFormat: 'json', kind: 'summary' });
      return extractJson<{ summary?: string }>(res.content)?.summary ?? res.content;
    });
    if (out.removed) d.memory.episodic.replaceMessages(sessionId, principal.userId, out.messages);
    d.db.run('INSERT INTO events (id, run_id, session_id, user_id, type, ts, data) VALUES (?,?,?,?,?,?,?)', newId('evt'), null, sessionId, principal.userId, 'context.compressed', nowIso(), toJson({ removed: out.removed }));
    return { before: msgs.length, after: out.messages.length };
  }
}

/** Convert a stored message back into a plain ChatMessage for the LLM. */
function stripStored(m: ChatMessage & { id?: string; seq?: number; runId?: string; createdAt?: string }): ChatMessage {
  return { role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId, name: m.name, attachments: m.attachments, untrusted: m.untrusted };
}
