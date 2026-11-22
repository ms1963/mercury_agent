/**
 * Slash commands shared by every front-end (CLI REPL, web chat, messaging gateway).
 * `CommandProcessor.handle()` is the single entry point for a user turn: it executes
 * a slash command, invokes a skill via `/<skill-name> [args]`, or runs the agent.
 */
import type { CheckpointManager } from '../checkpoints/checkpoints.js';
import type { HelpSystem } from '../help/help.js';
import type { Reflector } from '../reflection/reflector.js';
import type { ApprovalService } from '../tools/approvals.js';
import type { Agent, RunOptions, RunResult } from './agent.js';
import { formatInsights, formatUsage, insights, sessionUsage } from './insights.js';

export interface TurnOutput {
  output: string;
  sessionId: string;
  command?: string;
  run?: RunResult;
  data?: unknown;
}

type Handler = (args: string, opts: RunOptions & { sessionId: string }) => Promise<TurnOutput | string>;

interface CommandDef {
  name: string;
  usage: string;
  description: string;
  handler: Handler;
}

export class CommandProcessor {
  private defs = new Map<string, CommandDef>();

  constructor(
    private agent: Agent,
    private help: HelpSystem,
    private checkpoints: CheckpointManager,
    private approvals: ApprovalService,
    private reflector?: Reflector,
  ) {
    this.registerBuiltins();
  }

  register(def: CommandDef): void {
    this.defs.set(def.name, def);
  }

  list(): Array<{ name: string; usage: string; description: string }> {
    return [...this.defs.values()].map(({ name, usage, description }) => ({ name, usage, description }));
  }

  isCommand(input: string): boolean {
    const name = /^\/([\w-]+)/.exec(input.trim())?.[1];
    return !!name && (this.defs.has(name) || !!this.agent.deps.skills.get(name));
  }

  /** Handle one user turn. Creates a session when none is given. */
  async handle(opts: RunOptions): Promise<TurnOutput> {
    const mem = this.agent.deps.memory.episodic;
    const sessionId = opts.sessionId && mem.getSession(opts.sessionId) ? opts.sessionId : mem.createSession(opts.principal.userId, { id: opts.sessionId, platform: opts.platform, title: opts.input.slice(0, 60) }).id;
    const o = { ...opts, sessionId };
    const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(opts.input.trim());
    if (m) {
      const [, name, args] = m as unknown as [string, string, string];
      const def = this.defs.get(name);
      if (def) {
        const r = await def.handler(args.trim(), o);
        return typeof r === 'string' ? { output: r, sessionId, command: name } : { command: name, ...r };
      }
      const skill = this.agent.deps.skills.get(name);
      if (skill) {
        const run = await this.agent.run({
          ...o,
          input: args.trim() || `Apply the "${skill.meta.name}" skill.`,
          systemExtra: `## Active skill: ${skill.meta.name}\nFollow these instructions:\n${skill.body}`,
        });
        this.agent.deps.skills.recordUse(skill.meta.name, run.status === 'completed');
        return { output: run.output, sessionId: run.sessionId, run, command: name };
      }
    }
    const run = await this.agent.run(o);
    return { output: run.output, sessionId: run.sessionId, run };
  }

  private registerBuiltins(): void {
    const a = this.agent;
    const d = a.deps;
    const mem = d.memory.episodic;
    const add = (name: string, usage: string, description: string, handler: Handler) => this.register({ name, usage, description, handler });

    add('help', '/help [topic]', 'Show commands or a help topic', async (args) => {
      if (args) return this.help.get(args) ?? `No help topic "${args}". Topics:\n${this.help.index()}`;
      return `Commands:\n${this.list().map((c) => `  ${c.usage.padEnd(28)} ${c.description}`).join('\n')}\n\nSkills can be invoked with /<skill-name>. Help topics:\n${this.help.index()}`;
    });
    add('new', '/new', 'Start a new session', async (_args, o) => {
      const s = mem.createSession(o.principal.userId, { platform: o.platform });
      return { output: `New session ${s.id}`, sessionId: s.id, data: { sessionId: s.id } };
    });
    add('reset', '/reset', 'Clear the current session history', async (_args, o) => {
      mem.truncateFrom(o.sessionId, 0);
      return 'Session history cleared.';
    });
    add('model', '/model [provider/model|auto]', 'Show or switch the model for this session', async (args, o) => {
      if (!args) {
        const models = d.llm.registry.profilesList().filter((p) => p.enabled).map((p) => p.id);
        return `Current: ${mem.getSession(o.sessionId)?.model ?? d.config.llm.defaultModel}\nAvailable: ${models.join(', ')}`;
      }
      mem.updateSession(o.sessionId, { model: args === 'auto' ? undefined : args });
      return `Model for this session: ${args}`;
    });
    add('pattern', '/pattern [name|auto]', 'Show or switch the reasoning pattern', async (args, o) => {
      if (!args) return `Current: ${mem.getSession(o.sessionId)?.pattern ?? d.config.agent.pattern}\nAvailable: auto, ${d.patterns.list().map((p) => p.name).join(', ')}`;
      if (args !== 'auto' && !d.patterns.get(args)) return `Unknown pattern "${args}".`;
      mem.updateSession(o.sessionId, { pattern: args });
      return `Pattern for this session: ${args}`;
    });
    add('personality', '/personality [name]', 'Show or switch the personality', async (args, o) => {
      if (!args) return `Personalities: ${d.personalities.list().map((p) => `${p.name} (${p.title})`).join(', ')}`;
      if (!d.personalities.has(args)) return `Unknown personality "${args}".`;
      mem.updateSession(o.sessionId, { personality: args });
      return `Personality: ${args}`;
    });
    add('retry', '/retry', 'Re-run the last user message', async (_args, o) => {
      const msgs = mem.messages(o.sessionId);
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (!lastUser) return 'Nothing to retry.';
      mem.truncateFrom(o.sessionId, lastUser.seq);
      const run = await a.run({ ...o, input: lastUser.content.replace(/^<untrusted_content[^>]*>\n?|\n?<\/untrusted_content>$/g, ''), attachments: lastUser.attachments });
      return { output: run.output, sessionId: o.sessionId, run };
    });
    add('undo', '/undo', 'Remove the last exchange from the session', async (_args, o) => {
      const lastUser = [...mem.messages(o.sessionId)].reverse().find((m) => m.role === 'user');
      if (!lastUser) return 'Nothing to undo.';
      const n = mem.truncateFrom(o.sessionId, lastUser.seq);
      return `Removed ${n} message(s).`;
    });
    add('stop', '/stop', 'Stop the running turn in this session', async (_args, o) => `Stopped ${a.stop(o.sessionId, o.principal.role === 'admin' ? undefined : o.principal.userId)} run(s).`);
    add('compress', '/compress', 'Summarise older messages to free context', async (_args, o) => {
      const r = await a.compressSession(o.principal, o.sessionId);
      return r.before === r.after ? 'Nothing to compress yet.' : `Compressed ${r.before} → ${r.after} messages.`;
    });
    add('usage', '/usage', 'Token usage and cost of this session', async (_args, o) => formatUsage(sessionUsage(d.db, o.sessionId)));
    add('insights', '/insights [days]', 'Usage insights over time', async (args, o) => formatInsights(insights(d.db, o.principal.role === 'admin' && args.includes('all') ? undefined : o.principal.userId, Number.parseInt(args, 10) || 30)));
    add('skills', '/skills [name]', 'List skills or show one', async (args) => {
      if (args) return d.skills.get(args) ? `${d.skills.get(args)!.meta.description}\n\n${d.skills.view(args)}` : `No skill "${args}".`;
      const list = d.skills.list();
      return list.length ? list.map((s) => `  /${s.meta.name.padEnd(24)} ${s.meta.description.slice(0, 80)} (used ${s.stats.uses}×)`).join('\n') : 'No skills installed.';
    });
    add('rollback', '/rollback [checkpoint-id]', 'Undo file changes made by the agent', async (args, o) => {
      if (args === 'list') return this.checkpoints.list(o.sessionId).map((c) => `${c.id}  ${c.createdAt}  ${c.entries.length} file(s)  ${c.label}`).join('\n') || 'No checkpoints.';
      const r = this.checkpoints.rollback(args || undefined, o.sessionId);
      return r.restored.length ? `Restored ${r.restored.length} file(s):\n${r.restored.join('\n')}` : 'No checkpoint to roll back.';
    });
    add('approve', '/approve <id>', 'Approve a pending tool call', async (args, o) => (this.approvals.resolveAs(args, true, o.principal) ? 'Approved.' : `No pending approval ${args}.`));
    add('deny', '/deny <id>', 'Deny a pending tool call', async (args, o) => (this.approvals.resolveAs(args, false, o.principal) ? 'Denied.' : `No pending approval ${args}.`));
    add('approvals', '/approvals', 'List pending approvals', async (_a, o) => this.approvals.list(o.principal.userId).map((p) => `${p.id}  ${p.title}  ${p.detail.split('\n')[0]}`).join('\n') || 'No pending approvals.');
    add('memory', '/memory [query]', 'Show curated memory or search memories', async (args, o) => {
      if (!args) return `${d.memory.curated.read(o.principal.userId, 'memory') || '(MEMORY.md empty)'}\n${d.memory.curated.read(o.principal.userId, 'user') || '(USER.md empty)'}`;
      const hits = await d.memory.recall(o.principal.userId, args);
      return hits.map((h) => `- [${h.id}] ${h.content}`).join('\n') || 'No memories found.';
    });
    add('feedback', '/feedback good|bad', 'Rate the last answer (feeds reflection + calibration)', async (args, o) => {
      const last = d.db.get<{ id: string }>("SELECT id FROM runs WHERE session_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1", o.sessionId);
      if (!last || !this.reflector) return 'Nothing to rate.';
      const n = this.reflector.feedback(last.id, /^(good|\+|yes|👍)/i.test(args));
      return `Thanks! Feedback recorded (${n} decision(s) calibrated).`;
    });
    add('debug', '/debug on|off|llm|tool|list|resume <id>|skip <id>', 'Debug breakpoints', async (args) => {
      const [cmd, id] = args.split(/\s+/);
      if (cmd === 'on') d.debug.setGlobal({ llm: true, tool: true });
      else if (cmd === 'off') d.debug.setGlobal({ llm: false, tool: false });
      else if (cmd === 'llm') d.debug.setGlobal({ llm: !d.debug.getGlobal().llm });
      else if (cmd === 'tool') d.debug.setGlobal({ tool: !d.debug.getGlobal().tool });
      else if (cmd === 'resume' && id) return d.debug.resume(id) ? 'Resumed.' : 'Not paused.';
      else if (cmd === 'skip' && id) return d.debug.resume(id, { action: 'skip' }) ? 'Skipped.' : 'Not paused.';
      else if (cmd === 'list') return d.debug.list().map((p) => `${p.id} ${p.kind} ${JSON.stringify(p.payload).slice(0, 120)}`).join('\n') || 'Nothing paused.';
      return `Breakpoints: ${JSON.stringify(d.debug.getGlobal())}`;
    });
    add('tools', '/tools', 'List enabled toolsets for this platform', async (_a, o) =>
      d.tools.toolsets(o.platform).map((t) => `  ${t.enabled ? '✓' : '✗'} ${t.name.padEnd(12)} ${t.tools.length} tool(s)`).join('\n'),
    );
    add('sessions', '/sessions [query]', 'List or search past sessions', async (args, o) => {
      if (args) return mem.search(o.principal.userId, args).map((h) => `${h.sessionId}  ${h.title}: ${h.snippet}`).join('\n') || 'No matches.';
      return mem.listSessions(o.principal.userId, 20).map((s) => `${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`).join('\n');
    });
  }
}
