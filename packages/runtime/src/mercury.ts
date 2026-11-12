/**
 * Composition root: builds every subsystem from config and wires them into one
 * `Mercury` instance shared by the CLI, the HTTP server and the MCP server.
 * With no API keys configured everything runs on the offline mock providers.
 */
import { join } from 'node:path';
import {
  Agent,
  ApprovalService,
  AttachmentStore,
  AuditLog,
  BudgetService,
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
  /** Transport for gateway adapters (tests use MockTransport). */
  transport?: HttpTransport;
}

/** Build the decision provider chain for `decision.provider`. */
function decisionProviders(config: MercuryConfig, llm: LLMService, hasRealLlm: boolean): DecisionProvider[] {
  const d = config.decision;
  const jev = new JevDecisionProvider({ apiKey: process.env[d.jev.apiKeyEnv], model: d.jev.model, baseUrl: d.jev.baseUrl, timeoutMs: d.jev.timeoutMs });
  const llmProv = new LlmDecisionProvider(async (messages) => {
    const r = await llm.complete(SYSTEM_PRINCIPAL, messages, { model: d.llmModel, responseFormat: 'json', budgetOverride: true });
    return { content: r.content, model: r.modelId };
  });
  const mock = new MockDecisionProvider();
  const nonMockLlm = hasRealLlm && !config.llm.defaultModel.startsWith('mock/');
  switch (d.provider) {
    case 'jev':
      return [jev, mock];
    case 'llm':
      return [llmProv, mock];
    case 'mock':
      return [mock];
    default:
      return jev.available() ? [jev, ...(nonMockLlm ? [llmProv] : []), mock] : nonMockLlm ? [llmProv, mock] : [mock];
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

    this.users = new UserService(this.db, dataDir, config.auth.tokenTtlHours);
    this.pairing = new PairingService(this.db, this.users);
    this.policy = new PolicyEngine((id) => {
      try {
        return this.users.get(id).policy;
      } catch {
        return {};
      }
    });
    this.audit = new AuditLog(this.db);

    // LLM layer. The router needs judgment, judgment needs the decision engine,
    // and the LLM decision provider needs the LLM service: resolve with a late-bound array.
    this.providers = new ProviderRegistry(config);
    this.budgets = new BudgetService(this.db, config);
    this.decisions = new DecisionEngine([], this.bus, this.db);
    this.judgment = new Judgment(this.decisions, config);
    this.router = new ModelRouter(config, this.providers, this.judgment);
    this.llm = new LLMService(config, this.providers, this.router, this.budgets, this.policy, this.bus, this.hooks);
    this.decisionChain = decisionProviders(config, this.llm, this.providers.list().some((p) => p.id !== 'mock'));
    this.decisions.setProviders(this.decisionChain);

    this.tools = new ToolRegistry(config);
    registerBuiltinTools(this.tools);
    this.executor = new ToolExecutor(config, this.tools, this.policy, this.bus, this.judgment, this.hooks, this.audit);
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
    this.personalities = new Personalities([join(this.assets, 'personalities'), join(dataDir, 'personalities')]);
    this.help = new HelpSystem([join(this.assets, 'docs', 'help')]);
    this.i18n = new I18n(join(this.assets, 'locales'), config.locale);
    this.reflector = new Reflector(config, this.llm, this.judgment, this.memory, this.skills, this.db, this.bus);
    this.mcp = new McpClientManager(this.tools, this.logger, this.llm);

    this.services = {
      config, logger: this.logger, llm: this.llm, memory: this.memory, skills: this.skills, decisions: this.decisions,
      judgment: this.judgment, jail: this.jail, checkpoints: this.checkpoints, attachments: this.attachments,
      voice: this.voice, tools: this.tools, executor: this.executor, extra: {},
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
    const polyDirs = [join(this.assets, 'tools'), join(config.dataDir, 'tools'), ...config.tools.polyglotDirs];
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
