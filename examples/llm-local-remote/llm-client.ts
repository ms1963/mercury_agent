/**
 * llm-client.ts
 *
 * A self-contained, dependency-free LLM client that talks to BOTH a local
 * model server (Ollama / LM Studio / llama.cpp / vLLM) and a remote cloud
 * endpoint (Abacus.AI ChatLLM / OpenRouter / OpenAI) through the single
 * OpenAI "chat completions" wire format.
 *
 * It mirrors the design that Mercury itself uses: one transport, many backends,
 * selected purely by base URL and an optional API key. There are no mocks here
 * and no hidden fallbacks: if a backend is unreachable the call fails loudly.
 *
 * Requires Node.js >= 22.5 (global fetch, AbortSignal.timeout, async iteration
 * over a response body). Run with:  node --experimental-strip-types llm-client.ts
 */

/* ------------------------------------------------------------------ *
 * Domain model: a tiny, explicit vocabulary shared by every backend. *
 * ------------------------------------------------------------------ */

/** One turn in a conversation, in provider-neutral form. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Everything needed to reach exactly one backend. */
export interface BackendConfig {
  /** Human-readable name used in logs, e.g. "ollama" or "chatllm". */
  readonly name: string;
  /** OpenAI-compatible base URL, ending in "/v1" (no trailing slash). */
  readonly baseUrl: string;
  /** Model id understood by that backend, e.g. "llama3.1" or "route-llm". */
  readonly model: string;
  /** Bearer token for remote backends; omit for local servers that need none. */
  readonly apiKey?: string;
}

/** Normalised result returned to the caller regardless of backend. */
export interface ChatResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Options that shape a single request. */
export interface ChatOptions {
  /** Sampling temperature; lower is more deterministic. */
  readonly temperature?: number;
  /** Hard cap on generated tokens. */
  readonly maxTokens?: number;
  /** Called with each streamed text fragment when streaming is requested. */
  readonly onDelta?: (fragment: string) => void;
}

/**
 * Raised for transport-level failures. The `retryable` flag lets the retry
 * policy distinguish a transient 503 from a permanent 401.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/* ------------------------------------------------------------------ *
 * The client: one class, two transports (buffered JSON and SSE).     *
 * ------------------------------------------------------------------ */

export class OpenAICompatibleClient {
  constructor(private readonly config: BackendConfig) {}

  /** Build the request headers; the Authorization line is added only when a key exists. */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /** Assemble the request body shared by the buffered and streaming paths. */
  private body(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
    return JSON.stringify({
      model: this.config.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stream,
      // Ask OpenAI-compatible servers to include token usage in the final SSE chunk.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });
  }

  /**
   * POST the request with a timeout and translate HTTP/network failures into a
   * typed LlmError that carries a retryable flag (429 and 5xx are retryable).
   */
  private async post(messages: ChatMessage[], options: ChatOptions, stream: boolean): Promise<Response> {
    const url = `${this.config.baseUrl}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: this.body(messages, options, stream),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      // DNS failure, connection refused (local server down), or timeout.
      throw new LlmError(`network error calling ${this.config.name}: ${String(cause)}`, undefined, true);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(`${response.status} from ${this.config.name}: ${detail}`, response.status, retryable);
    }
    return response;
  }

  /** Request a complete answer in one buffered JSON response. */
  async complete(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const response = await this.post(messages, options, false);
    const json = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: json.model ?? this.config.model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * Stream the answer token by token. Each fragment is forwarded to
   * `options.onDelta` as it arrives, and the fully assembled text is returned
   * once the stream closes. The parser understands the Server-Sent-Events
   * framing every OpenAI-compatible server uses.
   */
  async stream(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const response = await this.post(messages, options, true);
    if (!response.body) {
      throw new LlmError(`empty stream from ${this.config.name}`, undefined, false);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });

      // SSE events are newline-delimited; process every complete line.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice('data:'.length).trimStart();
        if (payload === '[DONE]') {
          break;
        }
        const event = safeParse(payload);
        if (!event) {
          continue;
        }
        const fragment = event.choices?.[0]?.delta?.content;
        if (fragment) {
          text += fragment;
          options.onDelta?.(fragment);
        }
        if (event.usage) {
          inputTokens = event.usage.prompt_tokens ?? inputTokens;
          outputTokens = event.usage.completion_tokens ?? outputTokens;
        }
      }
    }

    return { text, model: this.config.model, inputTokens, outputTokens };
  }
}

/** Shape of the fragments of an OpenAI-compatible streaming chunk we read. */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Parse one SSE payload, returning undefined on malformed JSON rather than throwing. */
function safeParse(payload: string): StreamChunk | undefined {
  try {
    return JSON.parse(payload) as StreamChunk;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * A resilient wrapper: exponential backoff with bounded jitter, plus *
 * an ordered fallback across backends (try local first, then cloud). *
 * ------------------------------------------------------------------ */

/** Sleep helper used by the backoff loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call `complete` on the first backend; on a RETRYABLE failure retry with
 * exponential backoff and jitter, then move on to the next backend. A
 * non-retryable error (such as a 401 on a bad key) aborts immediately because
 * retrying it would only waste time and quota.
 */
export async function completeWithFallback(
  backends: readonly BackendConfig[],
  messages: ChatMessage[],
  options: ChatOptions & { retries?: number; backoffMs?: number; jitter?: number } = {},
): Promise<ChatResult> {
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const jitter = options.jitter ?? 0.5;
  let lastError: unknown;

  for (const backend of backends) {
    const client = new OpenAICompatibleClient(backend);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await client.complete(messages, options);
      } catch (error) {
        lastError = error;
        const canRetry = error instanceof LlmError && error.retryable && attempt < retries;
        if (!canRetry) {
          break; // Non-retryable, or out of attempts: fall through to the next backend.
        }
        const base = backoffMs * 2 ** attempt;
        const sleep = base + Math.random() * base * jitter;
        await delay(sleep);
      }
    }
  }
  throw new LlmError(`all backends failed; last error: ${String(lastError)}`, undefined, false);
}

/* ------------------------------------------------------------------ *
 * Demonstration: a local backend and a remote backend, same calls.   *
 * ------------------------------------------------------------------ */

/**
 * Build the backend list from the environment. The local backend needs no key;
 * the remote backend is included only when CHATLLM_API_KEY (or ABACUS_API_KEY)
 * is present, so the example also runs fully offline against Ollama alone.
 */
function backendsFromEnv(): BackendConfig[] {
  const backends: BackendConfig[] = [
    {
      name: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      model: process.env.OLLAMA_MODEL ?? 'llama3.1',
    },
  ];
  const remoteKey = process.env.CHATLLM_API_KEY ?? process.env.ABACUS_API_KEY;
  if (remoteKey) {
    backends.push({
      name: 'chatllm',
      baseUrl: 'https://routellm.abacus.ai/v1',
      model: 'route-llm',
      apiKey: remoteKey,
    });
  }
  return backends;
}

/** Entry point: stream from the first backend, then show the fallback helper. */
async function main(): Promise<void> {
  const backends = backendsFromEnv();
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'In one sentence, what is an agentic AI platform?' },
  ];

  const primary = new OpenAICompatibleClient(backends[0]!);
  process.stdout.write(`[streaming from ${backends[0]!.name}]\n`);
  const streamed = await primary.stream(messages, {
    temperature: 0.2,
    onDelta: (fragment) => process.stdout.write(fragment),
  });
  process.stdout.write(`\n[tokens in=${streamed.inputTokens} out=${streamed.outputTokens}]\n`);

  const resilient = await completeWithFallback(backends, messages, { temperature: 0.2 });
  process.stdout.write(`[fallback answer] ${resilient.text}\n`);
}

// Run main() only when executed directly, not when imported as a module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
