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
  /**
   * Economic lane for cost-aware routing:
   *  - 'local'    — routine/cheap work on a self-hosted lane (e.g. a DGX Spark cluster
   *                 endpoint), treated as near-zero marginal cost.
   *  - 'frontier' — hard reasoning on a premium hosted model.
   *  - 'default'  — unclassified; eligible for any task (backward-compatible default).
   */
  lane: z.enum(['local', 'frontier', 'default']).default('default'),
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
      /**
       * Per-model circuit breaker. A model profile that keeps failing with
       * *retryable* errors (429/5xx/network) trips its breaker and is skipped
       * fast (falling back to the next model) until it cools down. Non-retryable
       * errors (4xx/validation) never trip it. Tunable or fully disablable here
       * without code changes; defaults are safe and backward-compatible.
       */
      circuitBreaker: z
        .object({
          /** Master switch. When false the breaker is bypassed entirely. */
          enabled: z.boolean().default(true),
          /** Retryable failures within the window needed to open the breaker. */
          failureThreshold: z.number().int().positive().default(5),
          /** Time the breaker stays open before allowing a trial call, in ms. */
          cooldownMs: z.number().int().positive().default(30_000),
          /** Successful trial calls needed to close again from half-open. */
          halfOpenSuccesses: z.number().int().positive().default(1),
          /** Rolling window (ms) over which failures are counted while closed. */
          windowMs: z.number().int().positive().default(60_000),
        })
        .prefault({}),
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
      /**
       * Cost-aware, lane-based selection: pick the CHEAPEST enabled model whose quality
       * tier is sufficient for the task's estimated difficulty. Routine work stays on the
       * cheap/local lane; only hard-reasoning tasks escalate to frontier models. Fully
       * backward-compatible — disable to fall back to the pure weighted score.
       */
      economics: z
        .object({
          enabled: z.boolean().default(true),
          /**
           * A task whose estimated quality-need is at or below this threshold is "routine"
           * and may be served by the local lane; above it the task needs harder reasoning
           * and the local lane is excluded in favour of frontier/default models.
           */
          localLaneMaxDifficulty: z.number().min(0).max(1).default(0.55),
          /**
           * Minimum quality headroom a candidate must have over the estimated need to be
           * considered "likely to succeed" (guards against picking a just-barely model).
           */
          qualityMargin: z.number().min(0).max(1).default(0),
        })
        .prefault({}),
    })
    .prefault({}),

  budgets: z
    .object({
      enabled: z.boolean().default(true),
      adminBypass: z.boolean().default(true),
      rules: z.array(BudgetRuleSchema).default([]),
      /**
       * Hard PER-TASK budgets (distinct from the per-user/period rules above). A single
       * task/run may accumulate at most this much cost and/or tokens; when the cap would be
       * exceeded the task is halted/escalated instead of silently continuing. Caps left
       * undefined mean "no per-task cap" (backward-compatible default).
       */
      perTask: z
        .object({
          enabled: z.boolean().default(true),
          /** Max USD a single task may spend. Undefined → unlimited. */
          maxCost: z.number().positive().optional(),
          /** Max tokens a single task may consume. Undefined → unlimited. */
          maxTokens: z.number().positive().optional(),
          /** When a cap is exceeded: 'escalate' (emit + mark escalated) or 'halt' (just stop). */
          onExceed: z.enum(['escalate', 'halt']).default('escalate'),
          /** Assumed steps-to-completion used to project a running task's total cost. */
          projectedSteps: z.number().int().positive().default(6),
        })
        .prefault({}),
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
      // Speech-to-text. `provider` picks the port:
      //   'openai' | 'openai-compatible' → OpenAI-style /audio/transcriptions (point `baseUrl`
      //      at a self-hosted server such as faster-whisper-server/Speaches to go fully open source),
      //   'whisper' | 'command' → local CLI via `command`, 'mock' → test-only (MERCURY_ENABLE_MOCK=1).
      stt: z
        .object({
          provider: z.string().default('openai'),
          command: z.string().optional(),
          model: z.string().default('whisper-1'),
          /** OpenAI-compatible base URL (default https://api.openai.com/v1). Point this at a self-hosted server. */
          baseUrl: z.string().optional(),
          /** Env var holding the API key for the OpenAI-compatible path. */
          apiKeyEnv: z.string().default('OPENAI_API_KEY'),
          /** Optional response_format passed to the OpenAI-compatible endpoint (e.g. 'json', 'text'). */
          format: z.string().optional(),
        })
        .prefault({}),
      // Text-to-speech. `provider`: 'openai' | 'openai-compatible' → /audio/speech (point `baseUrl`
      // at e.g. openedai-speech/Kokoro-FastAPI), 'edge-tts' | 'piper' | 'command' → local/open CLI,
      // 'mock' → test-only (MERCURY_ENABLE_MOCK=1).
      tts: z
        .object({
          provider: z.string().default('openai'),
          command: z.string().optional(),
          voice: z.string().default('alloy'),
          /** OpenAI-compatible base URL (default https://api.openai.com/v1). Point this at a self-hosted server. */
          baseUrl: z.string().optional(),
          /** Env var holding the API key for the OpenAI-compatible path. */
          apiKeyEnv: z.string().default('OPENAI_API_KEY'),
          /** Model for the OpenAI-compatible path. */
          model: z.string().default('gpt-4o-mini-tts'),
          /** Output audio format for the OpenAI-compatible path ('mp3' | 'wav' | 'opus' | ...). */
          format: z.string().optional(),
        })
        .prefault({}),
      wakeWord: z.object({ command: z.string().optional() }).prefault({}),
    })
    .prefault({}),

  security: z
    .object({
      injection: z.object({ enabled: z.boolean().default(true), blockInput: z.boolean().default(false) }).prefault({}),
      redactSecrets: z.boolean().default(true),
      redactPiiInOutput: z.boolean().default(false),
      audit: z.boolean().default(true),
      /**
       * Least-privilege capability/credential broker. The agent never holds standing keys:
       * a sensitive action must hold a scoped, time-limited grant (issued per task, expiring
       * after `defaultTtlMs`) or it is denied. Disable only for trusted single-user setups.
       */
      grants: z
        .object({
          enabled: z.boolean().default(true),
          /** Default grant lifetime in ms when a caller does not specify one. */
          defaultTtlMs: z.number().int().positive().default(5 * 60_000),
          /** Hard upper bound on any requested TTL (clamped). */
          maxTtlMs: z.number().int().positive().default(60 * 60_000),
        })
        .prefault({}),
      /**
       * Policy-as-code. Declarative rules are evaluated BEFORE sensitive tool actions and can
       * allow, deny or route an action to human approval (e.g. "no payments over €100 without
       * approval", "never email external domains"). A small built-in rule set is enabled by
       * default; add/override rules here without code changes.
       */
      policies: z
        .object({
          enabled: z.boolean().default(true),
          /** Load the built-in payment-cap + external-email rules. */
          builtins: z.boolean().default(true),
          /** Max payment/charge amount (in `currency`) allowed without an approval, for the built-in rule. */
          paymentApprovalThreshold: z.number().nonnegative().default(100),
          currency: z.string().default('EUR'),
          /** Domains that email/send tools may target without approval (built-in external-email rule). */
          allowedEmailDomains: z.array(z.string()).default([]),
          /** Extra declarative rules. Evaluated in order; first matching non-allow effect wins. */
          rules: z
            .array(
              z.object({
                id: z.string(),
                description: z.string().default(''),
                /** Tool-name glob this rule applies to (e.g. "pay*", "*", "email_send"). */
                tool: z.string().default('*'),
                effect: z.enum(['allow', 'deny', 'approve']).default('approve'),
                /** Numeric arg + ceiling: trigger when `args[field] > max`. */
                maxAmountField: z.string().optional(),
                maxAmount: z.number().optional(),
                /** String arg that must match one of `allowedValues` (glob) or the rule triggers. */
                field: z.string().optional(),
                allowedValues: z.array(z.string()).optional(),
                /** Trigger only when the acting context is tainted by untrusted content. */
                whenTainted: z.boolean().default(false),
              }),
            )
            .default([]),
        })
        .prefault({}),
    })
    .prefault({}),

  observability: z
    .object({
      recordEvents: z.boolean().default(true),
      otlpEndpoint: z.string().optional(),
      metrics: z.boolean().default(true),
    })
    .prefault({}),

  wiki: z
    .object({
      /** Master switch for the LLM-Wiki subsystem (tools + CLI). */
      enabled: z.boolean().default(true),
      /** Wiki root directory. Empty → `<dataDir>/wiki`, resolved in the runtime. */
      dir: z.string().default(''),
      /** Schema/convention file name inside the wiki dir. */
      schemaFile: z.string().default('SCHEMA.md'),
      /** Pages whose body is shorter than this (chars) are flagged as stubs by lint. */
      stubMinChars: z.number().int().positive().default(200),
    })
    .prefault({}),

  /**
   * Unified Add-In system. End users add tools, personalities and permission profiles
   * by dropping declarative packages into `<dataDir>/addins/` — no source edits. Additive
   * and backward-compatible: the legacy dataDir/personalities, dataDir/tools and
   * dataDir/plugins scans keep working unchanged.
   */
  addins: z
    .object({
      /** Master switch for discovering add-ins. */
      enabled: z.boolean().default(true),
      /** Add-ins root directory. Empty → `<dataDir>/addins`, resolved in the runtime. */
      dir: z.string().default(''),
    })
    .prefault({}),

  /** Per-agent / per-personality permission profiles (declarative). */
  permissions: z
    .object({
      /** Permission profiles directory. Empty → `<dataDir>/permissions`, resolved in the runtime. */
      dir: z.string().default(''),
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
