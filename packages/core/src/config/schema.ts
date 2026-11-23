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
      /** Trust X-Forwarded-* headers (only behind a reverse proxy you control). Default off so
       *  clients cannot spoof their IP to evade the rate limiter. */
      trustProxy: z.union([z.boolean(), z.string(), z.number()]).default(false),
    })
    .prefault({}),

  auth: z
    .object({
      tokenTtlHours: z.number().default(24 * 7),
      allowRegistration: z.boolean().default(true),
      /** Upper bound (days) for API-token lifetimes; tokens created without a TTL get this one. 0 = unlimited. */
      apiTokenMaxTtlDays: z.number().int().min(0).default(365),
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
      /**
       * Governed long-term memory: route remember/recall/forget through policy + PII handling,
       * retention bounds and a queryable audit ledger. Backward-compatible and non-intrusive by
       * default — governance is `off`, so existing memory behaviour is unchanged until enabled.
       */
      governance: z
        .object({
          /**
           * Governance mode. `off` → no policy/PII/audit gating (legacy behaviour).
           * `soft` → PII is redacted (not blocked) and every op is audited, but writes/reads are
           * never denied. `strict` → policy is enforced (permission denials raised) and, when
           * `pii.block` is set, PII-bearing writes are rejected.
           */
          mode: z.enum(['off', 'soft', 'strict']).default('off'),
          /** Also enforce the auth PolicyEngine (memory.read / memory.write) on governed ops. */
          enforcePolicy: z.boolean().default(false),
          pii: z
            .object({
              /** Detect & handle PII (email, phone, SSN, credit-card, IP) in written content. */
              detect: z.boolean().default(true),
              /** Replace detected PII with placeholders instead of storing it verbatim. */
              redact: z.boolean().default(true),
              /** Reject a write that contains PII (strict mode only). Overrides redaction. */
              block: z.boolean().default(false),
            })
            .prefault({}),
        })
        .prefault({}),
      /** Retention bounds enforced on write (pruning) per user + namespace. */
      retention: z
        .object({
          /** Delete governed facts older than this many days (0 = keep forever). */
          ttlDays: z.number().default(0),
          /** Keep at most this many facts per user+namespace, pruning oldest (0 = unlimited). */
          maxItemsPerNamespace: z.number().default(0),
        })
        .prefault({}),
      /** Namespacing on top of per-user scope. */
      namespaces: z
        .object({
          /** Namespace applied when a caller does not specify one. */
          default: z.string().default('default'),
          /** When set, reject writes to a namespace not in this allow-list (strict mode). */
          allowed: z.array(z.string()).default([]),
        })
        .prefault({}),
      /** Knowledge / RAG over ingested sources, recalled with provenance. */
      knowledge: z
        .object({
          /** Enable the knowledge store (ingest/search) and grounding of buildContext(). */
          enabled: z.boolean().default(false),
          /** Target characters per chunk when ingesting a document. */
          chunkChars: z.number().default(900),
          /** Character overlap between consecutive chunks. */
          chunkOverlap: z.number().default(120),
          /** Number of knowledge hits to recall / ground into context. */
          recallK: z.number().default(4),
        })
        .prefault({}),
    })
    .prefault({}),

  skills: z
    .object({
      dirs: z.array(z.string()).default([]),
      autoCreate: z.boolean().default(true),
      minToolCallsForSkill: z.number().default(4),
      /**
       * Self-distilling skills: the agent distills reusable, parameterized skills from its own
       * successful/upvoted run traces, governs them (review → approve, versioned, promote/demote
       * by success-rate & cost) and reuses an approved matching skill to run proven paths. OFF by
       * default (opt-in, backward-compatible): nothing is distilled, matched or recorded until enabled.
       */
      distill: z
        .object({
          enabled: z.boolean().default(false),
          /** Skip governance review and mark newly distilled skills `approved` immediately. */
          autoApprove: z.boolean().default(false),
          /** A winning run must have made at least this many tool calls to distil a skill from it. */
          minToolCalls: z.number().int().positive().default(2),
          /** Minimum trigger/intent similarity (0..1) to match an incoming task to an approved skill. */
          matchMinSimilarity: z.number().min(0).max(1).default(0.3),
          /** Minimum trigger similarity (0..1) to treat a new trace as the SAME skill (dedup/version). */
          dedupMinSimilarity: z.number().min(0).max(1).default(0.6),
          /** A skill is eligible for auto-retire only after at least this many recorded uses. */
          minRunsBeforeRetire: z.number().int().positive().default(5),
          /** Auto-retire an approved skill whose observed success rate falls below this (0..1). */
          retireBelowSuccessRate: z.number().min(0).max(1).default(0.5),
          /** Hard cap on stored distilled skills (oldest retired ones are pruned beyond it). */
          maxSkills: z.number().int().positive().default(500),
        })
        .prefault({}),
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
      /** Host-level execution tools (terminal, process_start, execute_code) used by NON-admin users:
       *  'approve' (default) = every call needs an admin's approval, 'deny' = blocked,
       *  'allow' = treated like any other tool (pre-1.5 behaviour). Admins are unaffected. */
      hostAccess: z.object({ nonAdmin: z.enum(['approve', 'deny', 'allow']).default('approve') }).prefault({}),
      jail: z.object({ roots: z.array(z.string()).default([]), allowOutside: z.boolean().default(false) }).prefault({}),
      terminal: z
        .object({
          backend: z.string().default('local'),
          dockerImage: z.string().default('node:22-slim'),
          ssh: z.object({ host: z.string().optional(), user: z.string().optional(), keyPath: z.string().optional() }).prefault({}),
          timeoutMs: z.number().default(60_000),
          /** Extra environment variable names passed to shell commands. The default environment is
           *  scrubbed (no API keys / secrets); `['*']` restores full inheritance (not recommended). */
          envPassthrough: z.array(z.string()).default([]),
        })
        .prefault({}),
      web: z
        .object({
          searchProvider: z.enum(['duckduckgo', 'searxng', 'brave']).default('duckduckgo'),
          searxngUrl: z.string().optional(),
          allowPrivateNetworks: z.boolean().default(false),
          maxBytes: z.number().default(2_000_000),
          // Default backend for web_read: false = plain HTTP + HTML extraction (safe, no deps).
          // true = render through the headless-browser backend (tools.browser.backend) so
          // JavaScript-heavy pages resolve before extraction. A per-call `render` arg overrides this.
          render: z.boolean().default(false),
        })
        .prefault({}),
      browser: z.object({ backend: z.string().default('auto'), cdpUrl: z.string().optional() }).prefault({}),
      image: z.object({ provider: z.string().default('openai'), model: z.string().default('dall-e-3') }).prefault({}),
      executeCode: z
        .object({
          timeoutMs: z.number().default(30_000),
          maxToolCalls: z.number().default(50),
          /** Where model-written code runs: 'host' (child process), 'docker' (container without
           *  network, code dir mounted read-only) or 'auto' (docker when tools.terminal.backend is docker). */
          backend: z.enum(['auto', 'host', 'docker']).default('auto'),
          pythonImage: z.string().default('python:3.12-slim'),
          nodeImage: z.string().default('node:22-slim'),
        })
        .prefault({}),
      polyglotDirs: z.array(z.string()).default([]),
      /** Where polyglot tools run: 'host', 'docker' (no network, read-only tool folder, workdir
       *  read-only unless tool.json says otherwise; needs an image) or 'auto' (docker when
       *  tools.terminal.backend is docker and an image is known, else host). */
      polyglotBackend: z.enum(['auto', 'host', 'docker']).default('auto'),
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

  /**
   * Built-in verification. Every agent step/task can carry declarative checks (test, schema,
   * critic, assertion) that must pass before the task is considered done. A task finishes on
   * EVIDENCE (passed checks), not because the model claimed done; a verification result carries
   * a 0..1 confidence and escalates for human review when confidence < `confidenceThreshold`.
   * Fully backward-compatible — no step is required to declare checks.
   */
  verification: z
    .object({
      enabled: z.boolean().default(true),
      /** Below this aggregate confidence the result is not "done" and (if `escalate`) is flagged. */
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
      /** Record an escalation for human review when a verification falls below threshold. */
      escalate: z.boolean().default(true),
      /** Which check types are enabled; others are skipped (backward-compatible toggles). */
      checks: z.array(z.enum(['test', 'schema', 'critic', 'assertion'])).default(['test', 'schema', 'critic', 'assertion']),
      /** Automatically verify every completed top-level agent run with a critic check (opt-in:
       *  costs one extra judge call per run). Off = verification only via POST /api/verify. */
      autoVerify: z.boolean().default(false),
    })
    .prefault({}),

  /**
   * Reliability engineering: record/replay regression testing, chaos fault injection and
   * per-agent SLOs. Chaos is OFF by default and must be explicitly enabled.
   */
  reliability: z
    .object({
      /** Record completed runs (input, tool calls, output) so they can be replayed as regressions. */
      record: z.boolean().default(false),
      chaos: z
        .object({
          /** Master switch — MUST stay false unless deliberately testing recovery. */
          enabled: z.boolean().default(false),
          /** Probability [0..1] that an eligible tool call is made to fail. */
          failureProbability: z.number().min(0).max(1).default(0),
          /** Probability [0..1] that an eligible tool call is made to time out (slow failure). */
          timeoutProbability: z.number().min(0).max(1).default(0),
          /** Injected timeout delay in ms. */
          latencyMs: z.number().int().nonnegative().default(1000),
          /** Only inject failures into these tools (glob). Empty → all tools eligible. */
          tools: z.array(z.string()).default([]),
          /** Deterministic seed for reproducible chaos (undefined → Math.random). */
          seed: z.number().int().optional(),
        })
        .prefault({}),
      slo: z
        .object({
          /** Target success rate (0..1) per agent, for status colouring. */
          targetSuccessRate: z.number().min(0).max(1).default(0.9),
          /** Target max intervention/escalation rate (0..1). */
          maxInterventionRate: z.number().min(0).max(1).default(0.1),
          /** Target max average cost per task (USD). */
          maxCostPerTask: z.number().nonnegative().default(0.5),
          /** Window (days) over which SLOs are computed. */
          windowDays: z.number().int().positive().default(30),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Proactive (but not annoying): the agent reacts to events (new email, failing CI, price drop,
   * calendar conflict). Event sources produce events, rules map event patterns to agent actions,
   * a priority model decides interrupt-now vs defer, and low-priority updates are batched into a
   * periodic digest instead of interrupting. Disabled by default (opt-in, backward-compatible).
   */
  proactive: z
    .object({
      enabled: z.boolean().default(false),
      /** Priority at/above which an event interrupts immediately; below it is deferred to a digest. */
      interruptThreshold: z.number().min(0).max(1).default(0.7),
      /** How often (cron) to flush the digest of deferred low-priority events. */
      digestCron: z.string().default('0 9 * * *'),
      /** Default delivery for proactive notifications + digests (platform/target). */
      delivery: z.object({ platform: z.string().default('web'), target: z.string().default('') }).prefault({}),
      /** Declarative rules: match an event pattern → an agent action + base priority. */
      rules: z
        .array(
          z.object({
            id: z.string(),
            description: z.string().default(''),
            /** Event source glob (e.g. 'email', 'ci', '*'). */
            source: z.string().default('*'),
            /** Event kind glob (e.g. 'received', 'build.failed', 'price.drop'). */
            kind: z.string().default('*'),
            /** Substring that must appear in the event title/body for the rule to match. */
            contains: z.string().optional(),
            /** Agent task to run when matched (the event is interpolated with {{title}}/{{body}}). */
            action: z.string().optional(),
            /** Base priority 0..1 for matched events (the priority model may adjust it). */
            priority: z.number().min(0).max(1).default(0.5),
            /** Force immediate notify ('interrupt') or always defer ('digest'); omit → priority decides. */
            route: z.enum(['interrupt', 'digest']).optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),

  observability: z
    .object({
      recordEvents: z.boolean().default(true),
      otlpEndpoint: z.string().optional(),
      metrics: z.boolean().default(true),
      /**
       * Bearer token for GET /metrics. When unset, /metrics answers only direct loopback requests
       * (no X-Forwarded-* headers) and authenticated admins (audit.read).
       */
      metricsToken: z.string().optional(),
    })
    .prefault({}),

  /**
   * Deterministic run replay & time-travel debugging: persist a per-run trace (built on the
   * recorded event stream), scrub/inspect reconstructed state at any step, and fork a run from a
   * chosen step with edited inputs to deterministically recompute everything downstream while
   * reusing the upstream prefix. Enabled by default; backward-compatible.
   */
  replay: z
    .object({
      /** Master switch for trace persistence, the facade methods and the server endpoints. */
      enabled: z.boolean().default(true),
      /** Max number of per-run traces to retain (oldest pruned first). */
      retainTraces: z.number().int().positive().default(1000),
      /** Also persist reconstructed per-step state deltas (larger traces; off by default). */
      persistDeltas: z.boolean().default(false),
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

  /**
   * Learning from runs. The agent mines its own run history to (a) retrieve a concise hint
   * from the most similar PAST SUCCESSFUL run, (b) auto-tune routing from the ACTUAL observed
   * success/cost per difficulty-bucket + model, and (c) build failure playbooks (a recurring
   * error signature → the remediation that later worked). Master switch OFF by default
   * (fully backward-compatible): nothing is recorded, injected or adjusted until enabled.
   */
  learning: z
    .object({
      enabled: z.boolean().default(false),
      /** 1a — inject a hint from the most similar past successful run into the run-start context. */
      hints: z
        .object({
          enabled: z.boolean().default(true),
          /** How many past-success examples to summarise into the hint. */
          maxExamples: z.number().int().positive().default(1),
          /** Minimum token-overlap similarity (0..1) for a past run to count as "similar". */
          minSimilarity: z.number().min(0).max(1).default(0.15),
          /** Candidate past runs to consider (most recent first). */
          lookback: z.number().int().positive().default(50),
        })
        .prefault({}),
      /** 1b — adjust routing from observed outcomes per (difficulty bucket, model). */
      routing: z
        .object({
          enabled: z.boolean().default(true),
          /** Minimum recorded runs for a (bucket, model) pair before its stats influence routing. */
          minSamples: z.number().int().positive().default(5),
          /** A learned model must have at least this observed success rate to be preferred. */
          minSuccessRate: z.number().min(0).max(1).default(0.5),
        })
        .prefault({}),
      /** 1c — failure playbooks: recurring error signatures → remediation that later succeeded. */
      playbooks: z
        .object({
          enabled: z.boolean().default(true),
          /** Occurrences of an error signature before its playbook is surfaced. */
          minOccurrences: z.number().int().positive().default(2),
          /** Minimum task similarity (0..1) to surface a playbook for a new task. */
          minSimilarity: z.number().min(0).max(1).default(0.2),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Skill/tool composition: a composition can invoke other skills and tools, with intermediate
   * results cached (keyed on skill + inputs, TTL + size bounded) and a hard recursion guard
   * (depth limit + cycle detection). Additive — only runs when the `skill_compose` tool is used.
   */
  composition: z
    .object({
      enabled: z.boolean().default(true),
      /** Hard maximum nesting depth of sub-skill invocations (cycle/runaway guard). */
      maxDepth: z.number().int().positive().default(5),
      /** Maximum steps a single composition may run. */
      maxSteps: z.number().int().positive().default(40),
      cache: z
        .object({
          enabled: z.boolean().default(true),
          ttlMs: z.number().int().positive().default(300_000),
          maxSize: z.number().int().positive().default(500),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Workflow planning. The planner-executor template decomposes a task into several steps and
   * executes them with a step budget and a re-plan-on-failure path, so workflows run deeper than
   * a single shot. Planner is OFF by default (backward-compatible); existing templates are
   * unaffected. Hard caps bound the loop; per-task/workflow budgets still apply.
   */
  workflows: z
    .object({
      planner: z
        .object({
          enabled: z.boolean().default(false),
          /** Minimum number of steps a planned workflow must attempt. */
          minSteps: z.number().int().positive().default(3),
          /** Target number of steps the planner aims for. */
          targetSteps: z.number().int().positive().default(5),
          /** Hard cap on steps (runaway guard), also bounded by the workflow budget. */
          maxSteps: z.number().int().positive().default(12),
          /** Re-plan the remaining steps when a step fails instead of stopping. */
          replanOnFailure: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Evaluation-driven self-improvement: a closed evals + auto-tune loop. Promote real (or
   * 👍-rated) runs into labeled eval cases, replay a suite to score pass-rate / cost-per-task /
   * intervention-rate / output similarity (reusing the record/replay + SLO + economics machinery),
   * and let a governed "tuner" propose config/routing/skill changes that are only kept when they
   * improve the score without breaking governance or budget. Every accepted change is diffed,
   * versioned and reversible.
   *
   * The harness itself is ON by default but safe (it only reads/scores unless you run it); the
   * auto-tuner is OFF by default (it mutates config) and must be explicitly enabled.
   */
  evals: z
    .object({
      /** Master switch for the eval harness, facade methods and endpoints (safe: read/score only). */
      enabled: z.boolean().default(true),
      /** Max number of recorded suite scores to retain per suite (oldest pruned first). */
      retainScores: z.number().int().positive().default(500),
      /** Weights that combine the four metrics into a single 0..1 score (normalized internally). */
      weights: z
        .object({
          passRate: z.number().nonnegative().default(0.5),
          cost: z.number().nonnegative().default(0.2),
          intervention: z.number().nonnegative().default(0.15),
          similarity: z.number().nonnegative().default(0.15),
        })
        .prefault({}),
      /** Cost (in $) treated as the worst acceptable cost-per-task when normalizing the cost metric. */
      costCeiling: z.number().positive().default(0.05),
      /**
       * Governed auto-tune. A tuner subagent proposes changes (model routing, agent pattern,
       * distilled-skill promote/retire, prompt/temperature tweaks), tests each against the eval
       * suite, and keeps ONLY changes that improve the score by at least `minImprovement` without
       * breaking governance or the per-task budget. OFF by default (it mutates configuration).
       */
      autotune: z
        .object({
          enabled: z.boolean().default(false),
          /** Minimum absolute score gain (0..1) a proposal must deliver to be accepted. */
          minImprovement: z.number().min(0).max(1).default(0.02),
          /** Max proposals evaluated per tune request (runaway guard). */
          maxProposals: z.number().int().positive().default(8),
          /** Apply an accepted proposal automatically; when false, applying needs explicit approval. */
          autoApply: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Sharable agent bundles ("Mercury packs"): a single versioned, signed artifact bundling a skill
   * set + workflows + personality + policy + MCP presets. Export the current configuration (or a
   * subset) into a bundle file and install it into another Mercury instance in one command. Installs
   * verify the integrity signature (tamper detection), check version/compatibility, are idempotent,
   * and route policy/MCP-preset application through the normal governance/approval path.
   */
  bundles: z
    .object({
      /** Master switch for export/inspect/install (facade, CLI and endpoints). */
      enabled: z.boolean().default(true),
      /** Bundle storage directory. Empty → `<dataDir>/bundles`, resolved in the runtime. */
      dir: z.string().default(''),
      /**
       * HMAC-SHA256 integrity signing secret. Shared across instances that exchange bundles so an
       * installer can verify a bundle it did not create. The default lets bundles work out of the
       * box (integrity + tamper detection); override it in production for authenticity.
       */
      signingSecret: z.string().default('mercury-bundle-default-key'),
      /** Reject a bundle whose signature is missing or does not verify (tamper/compat guard). */
      requireSignature: z.boolean().default(true),
      /** Apply bundled policy-as-code rules immediately instead of queuing them for approval. */
      autoApprovePolicy: z.boolean().default(false),
      /** Apply bundled MCP presets/servers immediately instead of queuing them for approval. */
      autoApproveMcp: z.boolean().default(false),
    })
    .prefault({}),

  /**
   * Multi-agent orchestration ("teams"): a named, persisted config of several roles/agents plus an
   * orchestration strategy (coordinator→workers, pipeline, or debate/vote) runnable on one task. The
   * team delegates subtasks (reusing the workflow spawner + blackboard), aggregates results, degrades
   * gracefully on member failure, and is governed (per-run budget ceiling, optional approval, policy)
   * and auditable. OFF by default (opt-in, backward-compatible).
   */
  teams: z
    .object({
      /** Master switch for team define/run (facade, CLI and endpoints). */
      enabled: z.boolean().default(false),
      /** Maximum number of members a team definition may contain. */
      maxMembers: z.number().default(8),
      /** Default orchestration strategy when a definition does not set one. */
      defaultStrategy: z.enum(['coordinator', 'pipeline', 'debate']).default('coordinator'),
      /** Hard per-run cost ceiling (USD). 0 = unlimited. A run halts when the ceiling is reached. */
      budget: z.number().default(0),
      /** Require an explicit approval flag before a team run executes (governance gate). */
      requireApproval: z.boolean().default(false),
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
