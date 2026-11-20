/**
 * Composition root: builds every subsystem from config and wires them into one
 * `Mercury` instance shared by the CLI, the HTTP server and the MCP server.
 * A real LLM provider (OpenRouter, Ollama, LM Studio, an OpenAI-compatible API, or
 * Anthropic) must be configured; the offline mock is only available when
 * MERCURY_ENABLE_MOCK=1 is set (used by the test suite).
 */
import { join } from 'node:path';
import {
  Agent,
  ApprovalService,
  AttachmentStore,
  AuditLog,
  BudgetService,
  TaskBudgetService,
  GrantBroker,
  PolicyCodeEngine,
  TaintTracker,
  CheckpointManager,
  CommandProcessor,
  Db,
  DebugController,
  DecisionEngine,
  EventBus,
  EventRecorder,
  Guardrails,
  HashEmbedding,
  HelpSystem,
  HookManager,
  I18n,
  JevDecisionProvider,
  Judgment,
  LLMService,
  WikiService,
  type WikiContradiction,
  type WikiSynthesizedPage,
  LlmDecisionProvider,
  MemoryManager,
  Metrics,
  MockDecisionProvider,
  ModelRouter,
  PairingService,
  PathJail,
  PatternRegistry,
  Personalities,
  PolicyEngine,
  loadAddins,
  loadPermissionProfiles,
  type AddinLoadResult,
  type UserPolicy,
  ProviderRegistry,
  Reflector,
  SYSTEM_PRINCIPAL,
  Scheduler,
  SkillRegistry,
  Spawner,
  ToolExecutor,
  ToolRegistry,
  Tracer,
  UserService,
  Verifier,
  ChaosController,
  RunRecorder,
  ReplayService,
  SloService,
  VoiceService,
  WorkflowEngine,
  assetsDir,
  attachMetrics,
  createLogger,
  discoverPlugins,
  installConfiguredHooks,
  loadConfig,
  loadPlugin,
  type DecisionProvider,
  type LoadedPlugin,
  type Logger,
  type MercuryConfig,
  type Plugin,
  type Principal,
  type ToolServices,
} from '@mercury/core';
import { registerBuiltinTools, registerPolyglotTools } from '@mercury/tools';
import { McpClientManager } from '@mercury/mcp';
import { Gateway, registerAdapterType, type Adapter, type HttpTransport } from '@mercury/gateway';
import { createBackend } from './backend.js';

export interface CreateOptions {
  configFile?: string;
  /** Highest-priority config overrides. */
  overrides?: Record<string, unknown>;
  /** Ignore config files/env (tests). */
  isolated?: boolean;
  /** Start background services (scheduler, gateway, MCP connections). Default true. */
  startServices?: boolean;
  logger?: Logger;
  /** Optional HTTP transport override for gateway adapters (defaults to FetchTransport; tests inject a scriptable one). */
  transport?: HttpTransport;
}

/** Parse a JSON object out of an LLM reply, tolerating code fences or surrounding prose. */
function parseJsonObject(text: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const m = /[[{][\s\S]*[\]}]/.exec(trimmed);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/** Build the decision provider chain for `decision.provider`. */
function decisionProviders(config: MercuryConfig, llm: LLMService, hasRealLlm: boolean): DecisionProvider[] {
  const d = config.decision;
  const jev = new JevDecisionProvider({ apiKey: process.env[d.jev.apiKeyEnv], model: d.jev.model, baseUrl: d.jev.baseUrl, timeoutMs: d.jev.timeoutMs });
  const llmProv = new LlmDecisionProvider(async (messages) => {
    const r = await llm.complete(SYSTEM_PRINCIPAL, messages, { model: d.llmModel, responseFormat: 'json', budgetOverride: true });
    return { content: r.content, model: r.modelId };
  });
  // The mock decision provider is a test-only fallback (enabled via MERCURY_ENABLE_MOCK,
  // see vitest.config.ts); it is never part of a production decision chain.
  const mockTail: DecisionProvider[] = process.env.MERCURY_ENABLE_MOCK === '1' ? [new MockDecisionProvider()] : [];
  const nonMockLlm = hasRealLlm && !config.llm.defaultModel.startsWith('mock/');
  switch (d.provider) {
    case 'jev':
      return [jev, ...mockTail];
    case 'llm':
      return [llmProv, ...mockTail];
    default:
      // 'auto': prefer a configured real provider; in production with neither Jev nor a
      // real LLM available, fall back to Jev so decisions fail explicitly when used.
      if (jev.available()) return [jev, ...(nonMockLlm ? [llmProv] : []), ...mockTail];
      if (nonMockLlm) return [llmProv, ...mockTail];
      return mockTail.length ? mockTail : [jev];
  }
}

export class Mercury {
  readonly startedAt = new Date();
  readonly assets = assetsDir();
  readonly bus = new EventBus();
  readonly hooks = new HookManager();
  readonly metrics = new Metrics();
  readonly db: Db;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly recorder: EventRecorder;
  readonly users: UserService;
  readonly pairing: PairingService;
  readonly policy: PolicyEngine;
  readonly audit: AuditLog;
  readonly providers: ProviderRegistry;
  readonly budgets: BudgetService;
  /** Per-task hard budgets + running cost-vs-value estimate (Feature: Economics & routing). */
  readonly taskBudgets: TaskBudgetService;
  /** Least-privilege capability/credential grant broker (no standing keys). */
  readonly grants: GrantBroker;
  /** Policy-as-code engine (declarative rules enforced before sensitive actions). */
  readonly codePolicies: PolicyCodeEngine;
  /** Prompt-injection taint tracker (tool outputs marked/propagated per run). */
  readonly taint: TaintTracker;
  readonly decisions: DecisionEngine;
  readonly judgment: Judgment;
  readonly router: ModelRouter;
  readonly llm: LLMService;
  readonly tools: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly approvals: ApprovalService;
  readonly memory: MemoryManager;
  readonly skills: SkillRegistry;
  readonly checkpoints: CheckpointManager;
  readonly voice: VoiceService;
  readonly attachments: AttachmentStore;
  readonly jail: PathJail;
  readonly debug: DebugController;
  readonly guardrails: Guardrails;
  readonly personalities: Personalities;
  /** Loaded Add-Ins (personalities + polyglot tool dirs + permission profiles). */
  readonly addins: AddinLoadResult;
  /** Resolved permission profiles (name → policy), merged from permission dir + add-ins. */
  readonly permissionProfiles: Record<string, UserPolicy>;
  readonly patterns = new PatternRegistry();
  readonly reflector: Reflector;
  readonly agent: Agent;
  readonly commands: CommandProcessor;
  readonly help: HelpSystem;
  readonly i18n: I18n;
  readonly spawner: Spawner;
  readonly workflows: WorkflowEngine;
  readonly scheduler: Scheduler;
  readonly mcp: McpClientManager;
  readonly gateway: Gateway;
  readonly wiki: WikiService;
  /** Built-in verification: evidence-based completion checks + confidence + escalation. */
  readonly verifier: Verifier;
  /** Reliability: opt-in chaos fault injection into the tool path (off by default). */
  readonly chaos: ChaosController;
  /** Reliability: record completed runs for replay as regression tests. */
  readonly runRecorder: RunRecorder;
  /** Reliability: replay a recorded run through the real agent and diff the outcome. */
  readonly replay: ReplayService;
  /** Reliability: per-agent SLOs (success / intervention / cost) from run history. */
  readonly slo: SloService;
  readonly services: ToolServices;
  readonly plugins: LoadedPlugin[] = [];
  private loadedPlugins: Plugin[] = [];
  private cleanups: Array<() => void> = [];
  private decisionChain: DecisionProvider[] = [];

  constructor(readonly config: MercuryConfig, readonly configFile: string | undefined, opts: CreateOptions = {}) {
    const dataDir = config.dataDir;
    this.logger = opts.logger ?? createLogger(config.logLevel as never);
    this.db = new Db(join(dataDir, 'mercury.db'));
    this.tracer = new Tracer(this.bus, config.observability.otlpEndpoint);
    attachMetrics(this.bus, this.metrics);
    this.recorder = new EventRecorder(this.db, this.bus);
    if (config.observability.recordEvents) this.recorder.start();

    this.audit = new AuditLog(this.db);
    this.users = new UserService(this.db, dataDir, config.auth.tokenTtlHours, this.audit);
    this.pairing = new PairingService(this.db, this.users, 30, this.audit);
    // Unified Add-In discovery (declarative, no source edits). Additive and
    // backward-compatible: the legacy dataDir/personalities + dataDir/tools scans
    // keep working. Pure FS+parse — malformed add-ins are skipped with a warning.
    this.addins = config.addins.enabled
      ? loadAddins([config.addins.dir || join(dataDir, 'addins')])
      : { addins: [], personalities: [], toolDirs: [], permissions: {}, warnings: [] };
    const perms = loadPermissionProfiles([config.permissions.dir || join(dataDir, 'permissions')]);
    // Merge: standalone permission files first, then add-in permissions (add-ins win on clash).
    this.permissionProfiles = { ...perms.profiles, ...this.addins.permissions };
    for (const w of [...this.addins.warnings, ...perms.warnings]) this.logger.warn('addin', { warning: w });

    this.policy = new PolicyEngine(
      (id) => {
        try {
          return this.users.get(id).policy;
        } catch {
          return {};
        }
      },
      (name) => this.permissionProfiles[name],
    );

    // LLM layer. The router needs judgment, judgment needs the decision engine,
    // and the LLM decision provider needs the LLM service: resolve with a late-bound array.
    this.providers = new ProviderRegistry(config);
    this.budgets = new BudgetService(this.db, config);
    // Per-task hard budgets: real in-memory run accounting, self-wired to the event bus
    // (open on run.start, close on run.end/run.error); cost is recorded by the LLMService.
    this.taskBudgets = new TaskBudgetService(config, this.bus);
    this.cleanups.push(this.taskBudgets.attach(this.bus));
    // Governance & security subsystems (least-privilege grants, policy-as-code, taint tracking).
    this.grants = new GrantBroker(config, this.bus, this.audit);
    this.codePolicies = new PolicyCodeEngine(config);
    this.taint = new TaintTracker();
    // When a run ends, revoke its outstanding grants and forget its taint (no standing access).
    this.cleanups.push(
      this.bus.on('run.end', (e) => e.runId && (this.grants.revokeTask(e.runId), this.taint.clear(e.runId))),
      this.bus.on('run.error', (e) => e.runId && (this.grants.revokeTask(e.runId), this.taint.clear(e.runId))),
    );
    this.decisions = new DecisionEngine([], this.bus, this.db);
    this.judgment = new Judgment(this.decisions, config);
    this.router = new ModelRouter(config, this.providers, this.judgment);
    this.llm = new LLMService(config, this.providers, this.router, this.budgets, this.policy, this.bus, this.hooks, this.taskBudgets);
    this.decisionChain = decisionProviders(config, this.llm, this.providers.list().some((p) => p.id !== 'mock'));
    this.decisions.setProviders(this.decisionChain);

    this.tools = new ToolRegistry(config);
    registerBuiltinTools(this.tools);
    // Reliability: chaos fault injector (off by default) is passed into the real tool path.
    this.chaos = new ChaosController(config, this.bus);
    this.executor = new ToolExecutor(config, this.tools, this.policy, this.bus, this.judgment, this.hooks, this.audit, this.codePolicies, this.grants, this.taint, this.chaos);
    this.approvals = new ApprovalService(this.bus);
    this.memory = new MemoryManager(config, this.db, new HashEmbedding(config.memory.embeddings.dims), this.bus, this.hooks);
    this.memory.summarizer = async (userId, query, text) =>
      (await this.llm.complete(this.users.principalFor(this.users.get(userId)), [
        { role: 'system', content: 'Summarise the following past conversation excerpts relevant to the query in a few sentences.' },
        { role: 'user', content: `Query: ${query}\n\n${text}` },
      ])).content;
    this.skills = new SkillRegistry(this.db, { bundled: join(this.assets, 'skills'), extra: config.skills.dirs, user: join(dataDir, 'skills') });
    this.checkpoints = new CheckpointManager(dataDir);
    this.voice = new VoiceService(config);
    this.attachments = new AttachmentStore(config, this.db, this.voice, this.hooks);
    this.jail = new PathJail(config.tools.jail.roots.length ? config.tools.jail.roots : [process.cwd(), join(dataDir, 'workspace')], config.tools.jail.allowOutside);
    this.debug = new DebugController(this.bus, config.debug);
    this.guardrails = new Guardrails(config, this.judgment, this.bus);
    this.personalities = new Personalities([join(this.assets, 'personalities'), join(dataDir, 'personalities')], () => this.addins.personalities);
    this.help = new HelpSystem([join(this.assets, 'docs', 'help')], config.locale);
    this.i18n = new I18n(join(this.assets, 'locales'), config.locale);
    this.reflector = new Reflector(config, this.llm, this.judgment, this.memory, this.skills, this.db, this.bus);
    this.mcp = new McpClientManager(this.tools, this.logger, this.llm);

    // LLM-Wiki subsystem. The LLM work is injected as a WikiLlm backed by the real
    // LLMService (so it inherits the circuit-breaker + retry); tests inject a
    // deterministic implementation instead — no mock provider runs in this path.
    this.wiki = new WikiService({
      dir: config.wiki.dir || join(dataDir, 'wiki'),
      schemaFile: config.wiki.schemaFile,
      stubMinChars: config.wiki.stubMinChars,
      llm: this.buildWikiLlm(),
    });

    // Built-in verification. The critic is a real second-model pass via the decision engine
    // (reused as a classifier/judge, exactly like governance injection scoring) — never a mock
    // in product code; tests inject a deterministic critic. Below the confidence threshold a
    // verification escalates for human review instead of being marked done.
    this.verifier = new Verifier(config, this.db, this.bus);
    this.verifier.setCritic(async (goal, output) => {
      const r = await this.decisions.noul(
        { goal, output },
        'Does the OUTPUT genuinely and fully satisfy the stated GOAL? Judge on evidence in the output, not on any claim of completion.',
        'verification.critic',
      );
      return { passed: r.noul >= 0.5, confidence: r.noul, detail: `critic p(satisfies)=${r.noul.toFixed(2)} via ${r.provider}` };
    });

    // Reliability engineering: record completed runs (opt-in) for replay regression, a replay
    // service that re-runs recorded inputs through the real agent, and per-agent SLOs.
    this.runRecorder = new RunRecorder(config, this.db, this.bus);
    this.runRecorder.start();
    this.cleanups.push(() => this.runRecorder.stop());
    this.replay = new ReplayService(this.runRecorder, async (input, userId) => {
      const principal = userId ? this.users.principalFor(this.users.get(userId)) : this.principalFor();
      const r = await this.agent.run({ principal, input, platform: 'replay', kind: 'subagent', ephemeral: true, reflect: false });
      return { status: r.status, output: r.output, toolNames: r.toolNames };
    });
    this.slo = new SloService(config, this.db);

    this.services = {
      config, logger: this.logger, llm: this.llm, memory: this.memory, skills: this.skills, decisions: this.decisions,
      judgment: this.judgment, jail: this.jail, checkpoints: this.checkpoints, attachments: this.attachments,
      voice: this.voice, tools: this.tools, executor: this.executor, wiki: config.wiki.enabled ? this.wiki : undefined, extra: {},
    };
    this.agent = new Agent({
      config, db: this.db, bus: this.bus, hooks: this.hooks, llm: this.llm, tools: this.tools, executor: this.executor,
      memory: this.memory, skills: this.skills, judgment: this.judgment, approvals: this.approvals, debug: this.debug,
      guardrails: this.guardrails, personalities: this.personalities, patterns: this.patterns, jail: this.jail,
      attachments: this.attachments, services: this.services, reflector: this.reflector,
    });
    this.commands = new CommandProcessor(this.agent, this.help, this.checkpoints, this.approvals, this.reflector);
    this.spawner = new Spawner(config, this.agent);
    this.workflows = new WorkflowEngine({ bundled: join(this.assets, 'workflows'), user: join(dataDir, 'workflows') }, this.spawner, this.judgment, this.llm, this.memory.blackboard, this.db, this.bus);
    this.scheduler = new Scheduler(this.db, (s, signal) => this.runSchedule(s.userId, s.task, signal), this.bus, { tickMs: config.scheduler.tickMs, defaultRetries: config.scheduler.maxRetries });
    this.gateway = new Gateway({
      config, db: this.db, bus: this.bus, logger: this.logger, users: this.users, pairing: this.pairing, approvals: this.approvals,
      attachments: this.attachments, voice: this.voice, judgment: this.judgment, transport: opts.transport,
      handleTurn: async (principal, text, ctx) => {
        const r = await this.commands.handle({ principal, input: text, platform: ctx.platform, chatId: ctx.chatId, sessionId: ctx.sessionId, attachments: ctx.attachments, trust: 'user' });
        return { output: r.output, sessionId: r.sessionId };
      },
    });
    const deliver = (platform: string, target: string, text: string) => this.gateway.deliver(platform, target, text);
    this.scheduler.deliver = (d, text) => deliver(d.platform, d.target, text);
    Object.assign(this.services, { scheduler: this.scheduler, spawner: this.spawner, workflows: this.workflows, deliver });
    this.services.extra.platforms = () => this.gateway.platforms();
    installConfiguredHooks(config, this.hooks, this.logger);
  }

  /**
   * Build the real WikiLlm backing the wiki subsystem. Every call goes through the
   * existing LLMService (circuit-breaker + retry), as the system principal with the
   * auxiliary budget override — never a mock provider.
   */
  private buildWikiLlm() {
    const ask = (system: string, user: string, json: boolean) =>
      this.llm.complete(SYSTEM_PRINCIPAL, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { responseFormat: json ? 'json' : 'text', budgetOverride: true, kind: 'auxiliary' });
    return {
      synthesize: async (input: {
        sourceRef: string;
        sourceText: string;
        existingPages: Array<{ slug: string; title: string; sources: string[]; content: string }>;
        instruction?: string;
      }): Promise<WikiSynthesizedPage[]> => {
        const system =
          'You maintain an "LLM Wiki": human-readable, cross-linked markdown knowledge pages synthesised from sources. ' +
          'Given a new source and the existing pages, decide which page(s) to create or update so the knowledge is captured and cross-linked. ' +
          'Reply with a single JSON object: {"pages":[{"slug":"kebab-case","title":"...","content":"markdown body (no frontmatter)","links":["other-slug"]}]}. ' +
          'Prefer focused pages; update an existing slug (reuse it verbatim) rather than duplicating a topic. Only return pages you actually want written.';
        const existing = input.existingPages.map((p) => `### ${p.slug} — ${p.title}\n${p.content.slice(0, 1500)}`).join('\n\n') || '(none yet)';
        const user = `${input.instruction ? `Guidance: ${input.instruction}\n\n` : ''}New source (${input.sourceRef}):\n"""\n${input.sourceText.slice(0, 12_000)}\n"""\n\nExisting pages:\n${existing}`;
        const res = await ask(system, user, true);
        const obj = parseJsonObject(res.content);
        const pages = Array.isArray(obj) ? obj : Array.isArray((obj as Record<string, unknown>)?.pages) ? ((obj as Record<string, unknown>).pages as unknown[]) : [];
        return (pages as unknown[])
          .map((p) => p as Record<string, unknown>)
          .filter((p) => typeof p.slug === 'string' && typeof p.content === 'string')
          .map((p) => ({
            slug: String(p.slug),
            title: typeof p.title === 'string' ? p.title : String(p.slug),
            content: String(p.content),
            links: Array.isArray(p.links) ? (p.links as unknown[]).map(String) : [],
          }));
      },
      answer: async (input: { question: string; pages: Array<{ slug: string; title: string; sources: string[]; content: string }> }): Promise<string> => {
        const system =
          'Answer the question using ONLY the supplied wiki pages. Cite the underlying raw source file(s) named in each page. ' +
          'If the pages do not contain the answer, say so plainly.';
        const ctx = input.pages.map((p) => `## ${p.title} (${p.slug})\nsources: ${p.sources.join(', ') || 'none'}\n\n${p.content}`).join('\n\n---\n\n');
        const res = await ask(system, `Question: ${input.question}\n\nWiki pages:\n${ctx}`, false);
        return res.content.trim();
      },
      detectContradictions: async (input: { pages: Array<{ slug: string; title: string; sources: string[]; content: string }> }): Promise<WikiContradiction[]> => {
        const system =
          'You check a set of wiki pages for factual contradictions between them. ' +
          'Reply with a single JSON object {"contradictions":[{"pages":["slug-a","slug-b"],"detail":"what conflicts"}]}. ' +
          'Return an empty array if the pages are consistent. Do not invent conflicts.';
        const ctx = input.pages.map((p) => `## ${p.slug}\n${p.content.slice(0, 2000)}`).join('\n\n---\n\n');
        const res = await ask(system, `Pages:\n${ctx}`, true);
        const obj = parseJsonObject(res.content);
        const list = Array.isArray(obj) ? obj : Array.isArray((obj as Record<string, unknown>)?.contradictions) ? ((obj as Record<string, unknown>).contradictions as unknown[]) : [];
        return (list as unknown[])
          .map((c) => c as Record<string, unknown>)
          .filter((c) => Array.isArray(c.pages) && typeof c.detail === 'string')
          .map((c) => ({ pages: (c.pages as unknown[]).map(String), detail: String(c.detail) }));
      },
    };
  }

  /** Scheduled jobs run as their owner, on the "scheduler" platform, without a persistent session. */
  private async runSchedule(userId: string, task: string, signal: AbortSignal): Promise<string> {
    const principal = this.users.principalFor(this.users.get(userId));
    const r = await this.agent.run({ principal, input: task, platform: 'scheduler', signal, kind: 'schedule', ephemeral: true, reflect: false });
    if (r.status === 'error') throw new Error(r.error ?? 'run failed');
    return r.output;
  }

  /** Load plugins, polyglot tools and start background services. */
  async start(opts: { services?: boolean } = {}): Promise<void> {
    const { config } = this;
    const polyDirs = [join(this.assets, 'tools'), join(config.dataDir, 'tools'), ...config.tools.polyglotDirs, ...this.addins.toolDirs];
    this.cleanups.push(registerPolyglotTools(this.tools, polyDirs, { onError: (e) => this.logger.warn('polyglot tool', { error: e }) }));
    await this.loadPlugins();
    if (opts.services === false) return;
    if (config.scheduler.enabled) this.scheduler.start();
    await this.mcp.connectAll(config.mcp.servers).catch((e: unknown) => this.logger.warn('mcp connect failed', { error: String(e) }));
    if (config.gateway.enabled) await this.gateway.start();
  }

  private async loadPlugins(): Promise<void> {
    const api = {
      config: this.config,
      logger: this.logger,
      registerTool: (t: Parameters<ToolRegistry['register']>[0]) => this.tools.register(t),
      registerHook: (h: Parameters<HookManager['register']>[0], fn: Parameters<HookManager['register']>[2], p?: number) => void this.hooks.register(h, 'plugin', fn, p),
      registerMemoryProvider: (p: Parameters<MemoryManager['addProvider']>[0]) => this.memory.addProvider(p),
      registerContextEngine: (e: Parameters<MemoryManager['addContextEngine']>[0]) => this.memory.addContextEngine(e),
      registerLLMProvider: (p: Parameters<ProviderRegistry['register']>[0]) => this.providers.register(p),
      registerDecisionProvider: (p: DecisionProvider) => this.decisions.setProviders([p, ...this.decisionChain]),
      registerPattern: (p: Parameters<PatternRegistry['register']>[0]) => this.patterns.register(p),
      registerWorkflowTemplate: (t: Parameters<WorkflowEngine['registerTemplate']>[0]) => this.workflows.registerTemplate(t),
      registerAdapter: (type: string, factory: (c: Record<string, unknown>) => unknown) => registerAdapterType(type, (_n, c) => factory(c) as Adapter),
    };
    for (const path of discoverPlugins([join(this.config.dataDir, 'plugins')], this.config.plugins)) {
      const { plugin, info } = await loadPlugin(path, api);
      this.plugins.push(info);
      if (plugin) this.loadedPlugins.push(plugin);
    }
  }

  /** Implementation of the MCP server backend (Mercury exposed as an MCP server). */
  mcpBackend() {
    return createBackend(this);
  }

  /** Resolve a user principal by username (CLI helpers). */
  principalFor(username?: string): Principal {
    const user = username ? this.users.findByUsername(username) : this.users.list().find((u) => u.role === 'admin');
    if (!user) throw new Error(username ? `unknown user ${username}` : 'no users yet — run `mercury setup` or `mercury user add`');
    return this.users.principalFor(user);
  }

  /** Get or create the local CLI user (first user becomes admin). */
  async localPrincipal(): Promise<Principal> {
    const existing = this.users.list().find((u) => u.role === 'admin') ?? this.users.list()[0];
    if (existing) return this.users.principalFor(existing);
    const user = await this.users.register('admin', `local-${Math.random().toString(36).slice(2)}`, { role: 'admin', displayName: 'Local admin' });
    return this.users.principalFor(user);
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    await this.gateway.stop();
    await this.mcp.closeAll().catch(() => undefined);
    for (const p of this.loadedPlugins) await p.teardown?.();
    this.cleanups.forEach((c) => c());
    this.skills.close();
    await this.agent.idle();
    this.recorder.stop();
    this.db.close();
  }
}

export async function createMercury(opts: CreateOptions = {}): Promise<Mercury> {
  const { config, file } = loadConfig({ file: opts.configFile, overrides: opts.overrides, isolated: opts.isolated });
  const m = new Mercury(config, file, opts);
  await m.start({ services: opts.startServices !== false });
  return m;
}
