/**
 * Mercury configuration schema (zod). Every field has a sensible default so an
 * empty config file yields a working setup once an LLM provider is configured.
 *
 * Layering (lowest → highest): defaults < config file < environment < CLI flags.
 */
import { z } from 'zod';

const ProviderSchema = z.object({
  /** openai | anthropic | openrouter | chatllm | ollama | lmstudio | openai-compatible */
  type: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  /** Name of an environment variable holding the API key (preferred over apiKey). */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
});

/** A model profile used by the router for capability filtering and scoring. */
const ModelProfileSchema = z.object({
  id: z.string(), // "<provider>/<model>"
  tags: z.array(z.string()).default([]),
  quality: z.number().min(0).max(1).default(0.5),
  costPer1MInput: z.number().default(0),
  costPer1MOutput: z.number().default(0),
  latencyMs: z.number().default(1000),
  contextWindow: z.number().default(8192),
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
  audio: z.boolean().default(false),
  json: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const RouterRuleSchema = z.object({
  /** Regex matched (case-insensitive) against the task text. */
  match: z.string().optional(),
  /** Tags the task must carry (e.g. "code", "vision"). */
  tags: z.array(z.string()).optional(),
  model: z.string(),
});

const BudgetRuleSchema = z.object({
  /** User id, or "*" for everybody. */
  user: z.string().default('*'),
  /** Model id, or "*" for all models. */
  model: z.string().default('*'),
  period: z.enum(['daily', 'monthly']).default('daily'),
  maxTokens: z.number().optional(),
  maxCost: z.number().optional(),
});

const McpServerSchema = z.object({
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  trust: z.enum(['trusted', 'untrusted']).default('untrusted'),
  allowSampling: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  dataDir: z.string().default(''),
  locale: z.string().default('en'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  debug: z.boolean().default(false),

  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().default(3000),
      publicUrl: z.string().optional(),
      rateLimit: z.object({ windowMs: z.number().default(60_000), max: z.number().default(300) }).prefault({}),
      maxBodyBytes: z.number().default(30 * 1024 * 1024),
    })
    .prefault({}),

  auth: z
    .object({
      tokenTtlHours: z.number().default(24 * 7),
      allowRegistration: z.boolean().default(true),
    })
    .prefault({}),

  llm: z
    .object({
      defaultModel: z.string().default('auto'),
      providers: z.record(z.string(), ProviderSchema).default({}),
      models: z.array(ModelProfileSchema).default([]),
      retries: z.number().default(2),
      timeoutMs: z.number().default(120_000),
      /** Base delay (ms) for the exponential retry backoff: base * 2^attempt. */
      retryBackoffMs: z.number().default(500),
      /** Jitter fraction (0..1) added on top of each backoff delay to avoid thundering herds. */
      retryJitter: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),

  router: z
    .object({
      enabled: z.boolean().default(true),
      weights: z
        .object({ quality: z.number().default(1), cost: z.number().default(0.3), latency: z.number().default(0.2) })
        .prefault({}),
      rules: z.array(RouterRuleSchema).default([]),
      fallback: z.array(z.string()).default([]),
      useDecisions: z.boolean().default(true),
      topK: z.number().default(3),
    })
    .prefault({}),

  budgets: z
    .object({
      enabled: z.boolean().default(true),
      adminBypass: z.boolean().default(true),
      rules: z.array(BudgetRuleSchema).default([]),
    })
    .prefault({}),

  decision: z
    .object({
      /** auto = jev when OPENROUTER_API_KEY is set, otherwise the LLM-based decision provider. */
      provider: z.enum(['auto', 'jev', 'llm']).default('auto'),
      jev: z
        .object({
          model: z.string().default('typesafe/jev-1.13'),
          baseUrl: z.string().default('https://openrouter.ai/api/alpha'),
          apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
          timeoutMs: z.number().default(20_000),
        })
        .prefault({}),
      llmModel: z.string().default('auto'),
      thresholds: z
        .object({
          injection: z.number().default(0.7),
          toolApproval: z.number().default(0.8),
          triageReview: z.number().default(0.8),
          retry: z.number().default(0.6),
          answerQuality: z.number().default(0.5),
        })
        .prefault({}),
      use: z
        .object({
          routing: z.boolean().default(true),
          patternSelection: z.boolean().default(true),
          toolGate: z.boolean().default(true),
          injection: z.boolean().default(true),
          triage: z.boolean().default(true),
          reflection: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),

  agent: z
    .object({
      pattern: z.string().default('react'),
      maxIterations: z.number().default(12),
      maxSubagents: z.number().default(3),
      maxDepth: z.number().default(2),
      personality: z.string().default('default'),
      temperature: z.number().default(0.3),
      textReactFallback: z.boolean().default(true),
      nudgeEvery: z.number().default(8),
      compression: z.object({ threshold: z.number().default(0.75), keepLast: z.number().default(6) }).prefault({}),
      toolTimeoutMs: z.number().default(60_000),
    })
    .prefault({}),

  memory: z
    .object({
      memoryCharLimit: z.number().default(2200),
      userCharLimit: z.number().default(1375),
      recallK: z.number().default(5),
      embeddings: z
        .object({
          provider: z.enum(['hash', 'openai', 'ollama']).default('hash'),
          model: z.string().default('text-embedding-3-small'),
          dims: z.number().default(256),
          baseUrl: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),

  skills: z
    .object({
      dirs: z.array(z.string()).default([]),
      autoCreate: z.boolean().default(true),
      minToolCallsForSkill: z.number().default(4),
    })
    .prefault({}),

  reflection: z
    .object({ enabled: z.boolean().default(true), lessons: z.boolean().default(true), userModel: z.boolean().default(true) })
    .prefault({}),

  tools: z
    .object({
      disabled: z.array(z.string()).default([]),
      toolsets: z.record(z.string(), z.boolean()).default({}),
      platforms: z.record(z.string(), z.object({ disabledToolsets: z.array(z.string()).default([]) })).default({}),
      approvals: z.object({ mode: z.enum(['manual', 'auto', 'smart', 'deny']).default('manual') }).prefault({}),
      jail: z.object({ roots: z.array(z.string()).default([]), allowOutside: z.boolean().default(false) }).prefault({}),
      terminal: z
        .object({
          backend: z.string().default('local'),
          dockerImage: z.string().default('node:22-slim'),
          ssh: z.object({ host: z.string().optional(), user: z.string().optional(), keyPath: z.string().optional() }).prefault({}),
          timeoutMs: z.number().default(60_000),
        })
        .prefault({}),
      web: z
        .object({
          searchProvider: z.enum(['duckduckgo', 'searxng', 'brave']).default('duckduckgo'),
          searxngUrl: z.string().optional(),
          allowPrivateNetworks: z.boolean().default(false),
          maxBytes: z.number().default(2_000_000),
        })
        .prefault({}),
      browser: z.object({ backend: z.string().default('auto'), cdpUrl: z.string().optional() }).prefault({}),
      image: z.object({ provider: z.string().default('openai'), model: z.string().default('dall-e-3') }).prefault({}),
      executeCode: z.object({ timeoutMs: z.number().default(30_000), maxToolCalls: z.number().default(50) }).prefault({}),
      polyglotDirs: z.array(z.string()).default([]),
    })
    .prefault({}),

  mcp: z
    .object({
      servers: z.record(z.string(), McpServerSchema).default({}),
      server: z.object({ enabled: z.boolean().default(true), path: z.string().default('/mcp') }).prefault({}),
    })
    .prefault({}),

  gateway: z
    .object({
      enabled: z.boolean().default(false),
      continuity: z.enum(['per-user', 'per-chat']).default('per-user'),
      pairing: z.boolean().default(true),
      triage: z.boolean().default(false),
      adapters: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    })
    .prefault({}),

  scheduler: z
    .object({ enabled: z.boolean().default(true), tickMs: z.number().default(30_000), maxRetries: z.number().default(2) })
    .prefault({}),

  attachments: z
    .object({
      maxBytes: z.number().default(25 * 1024 * 1024),
      allowedKinds: z.array(z.string()).default(['image', 'audio', 'video', 'document', 'other']),
      scanCommand: z.string().optional(),
    })
    .prefault({}),

  voice: z
    .object({
      stt: z.object({ provider: z.string().default('openai'), command: z.string().optional(), model: z.string().default('whisper-1') }).prefault({}),
      tts: z.object({ provider: z.string().default('openai'), command: z.string().optional(), voice: z.string().default('alloy') }).prefault({}),
      wakeWord: z.object({ command: z.string().optional() }).prefault({}),
    })
    .prefault({}),

  security: z
    .object({
      injection: z.object({ enabled: z.boolean().default(true), blockInput: z.boolean().default(false) }).prefault({}),
      redactSecrets: z.boolean().default(true),
      redactPiiInOutput: z.boolean().default(false),
      audit: z.boolean().default(true),
    })
    .prefault({}),

  observability: z
    .object({
      recordEvents: z.boolean().default(true),
      otlpEndpoint: z.string().optional(),
      metrics: z.boolean().default(true),
    })
    .prefault({}),

  plugins: z.array(z.string()).default([]),
  hooks: z
    .array(z.object({ event: z.string(), type: z.enum(['log', 'webhook']).default('log'), url: z.string().optional() }))
    .default([]),
});

export type MercuryConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type BudgetRule = z.infer<typeof BudgetRuleSchema>;
export { McpServerSchema, ModelProfileSchema };
