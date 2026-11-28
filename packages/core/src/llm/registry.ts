/**
 * Builds LLM providers from config + environment and resolves "<provider>/<model>" ids.
 */
import type { MercuryConfig, ModelProfile, ProviderConfig } from '../config/schema.js';
import { MercuryError } from '../types/common.js';
import type { ModelCapabilities } from '../types/messages.js';
import type { LLMProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { DEFAULT_BASE_URLS, OpenAICompatibleProvider } from './providers/openai.js';

/** Built-in model profiles used by the router when the provider is configured. */
export const BUILTIN_PROFILES: Array<Partial<ModelProfile> & { id: string }> = [
  { id: 'mock/echo', tags: ['mock', 'general'], quality: 0.1, latencyMs: 1, contextWindow: 32_000 },
  { id: 'mock/react-text', tags: ['mock'], quality: 0.05, latencyMs: 1, tools: false, enabled: false },
  { id: 'mock/vision', tags: ['mock', 'vision'], quality: 0.1, latencyMs: 1, vision: true, enabled: false },
  { id: 'openai/gpt-4o-mini', tags: ['general', 'fast', 'cheap'], quality: 0.7, costPer1MInput: 0.15, costPer1MOutput: 0.6, latencyMs: 800, contextWindow: 128_000, vision: true },
  { id: 'openai/gpt-4o', tags: ['general', 'code', 'reasoning'], quality: 0.85, costPer1MInput: 2.5, costPer1MOutput: 10, latencyMs: 1500, contextWindow: 128_000, vision: true },
  { id: 'anthropic/claude-sonnet-4-5', tags: ['general', 'code', 'reasoning', 'writing'], quality: 0.92, costPer1MInput: 3, costPer1MOutput: 15, latencyMs: 2000, contextWindow: 200_000, vision: true },
  { id: 'anthropic/claude-haiku-4-5', tags: ['general', 'fast'], quality: 0.75, costPer1MInput: 1, costPer1MOutput: 5, latencyMs: 900, contextWindow: 200_000, vision: true },
  { id: 'openrouter/openai/gpt-4o-mini', tags: ['general', 'fast', 'cheap'], quality: 0.7, costPer1MInput: 0.15, costPer1MOutput: 0.6, latencyMs: 1000, contextWindow: 128_000, vision: true },
  { id: 'ollama/llama3.1', tags: ['general', 'local', 'private'], quality: 0.55, latencyMs: 2500, contextWindow: 32_768 },
  { id: 'lmstudio/local-model', tags: ['general', 'local', 'private'], quality: 0.5, latencyMs: 2500, contextWindow: 32_768 },
  // Abacus.AI ChatLLM / RouteLLM. "route-llm" auto-selects the best model per request.
  { id: 'chatllm/route-llm', tags: ['general', 'code', 'reasoning', 'fast'], quality: 0.88, latencyMs: 1500, contextWindow: 128_000, vision: true },
  { id: 'chatllm/gpt-4o-mini', tags: ['general', 'fast', 'cheap'], quality: 0.7, latencyMs: 900, contextWindow: 128_000, vision: true },
  { id: 'chatllm/claude-sonnet-4-5', tags: ['general', 'code', 'reasoning', 'writing'], quality: 0.92, latencyMs: 2000, contextWindow: 200_000, vision: true },
];

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  chatllm: 'CHATLLM_API_KEY',
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private profiles = new Map<string, ModelProfile>();

  constructor(private config: MercuryConfig) {
    // The mock provider is NOT a configurable backend: Mercury requires a real LLM
    // (OpenRouter, Ollama, LM Studio, an OpenAI-compatible API, or Anthropic).
    // The offline mock exists solely for the test suite and is enabled only when
    // MERCURY_ENABLE_MOCK=1 is set (see vitest.config.ts).
    if (process.env.MERCURY_ENABLE_MOCK === '1') this.register(new MockProvider());
    // Capability overrides so a provider's own wire-format builder (e.g. image_url parts
    // in OpenAICompatibleProvider.toWire) sees the SAME capabilities the registry/router
    // use — i.e. the model profile's flags, not just a guess from the model name. Without
    // this, auto-routed ids like "chatllm/route-llm" (vision via profile, but no vision
    // keyword in the name) get their images silently dropped by the provider. Read lazily
    // so profiles populated later in this constructor are visible at call time.
    const overridesFor = (id: string) => (model: string): Partial<ModelCapabilities> | undefined => {
      const prof = this.profiles.get(`${id}/${model}`);
      return prof ? { tools: prof.tools, vision: prof.vision, audio: prof.audio, contextWindow: prof.contextWindow } : undefined;
    };
    // Auto-enable cloud providers whose API key is present in the environment.
    for (const [id, env] of Object.entries(ENV_KEYS)) {
      if (process.env[env] && !config.llm.providers[id]) this.register(createProvider(id, { type: id, enabled: true }, config.llm.timeoutMs, overridesFor(id)));
    }
    for (const [id, pc] of Object.entries(config.llm.providers)) {
      if (pc.enabled) this.register(createProvider(id, pc, config.llm.timeoutMs, overridesFor(id)));
    }
    for (const p of BUILTIN_PROFILES) {
      const provider = p.id.split('/')[0]!;
      if (this.providers.has(provider)) this.profiles.set(p.id, normalizeProfile(p));
    }
    for (const p of config.llm.models) this.profiles.set(p.id, p);
  }

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  /** Split "openrouter/anthropic/claude" → provider "openrouter", model "anthropic/claude". */
  resolve(modelId: string): { provider: LLMProvider; model: string } {
    const slash = modelId.indexOf('/');
    if (slash < 0) throw new MercuryError(`Model id must be "<provider>/<model>": ${modelId}`, 'invalid_model', 'models');
    const provider = this.providers.get(modelId.slice(0, slash));
    if (!provider) throw new MercuryError(`Unknown or unconfigured provider "${modelId.slice(0, slash)}" (model ${modelId})`, 'unknown_provider', 'models');
    return { provider, model: modelId.slice(slash + 1) };
  }

  profile(modelId: string): ModelProfile {
    const existing = this.profiles.get(modelId);
    if (existing) return existing;
    const caps = this.capabilities(modelId);
    return normalizeProfile({ id: modelId, tools: caps.tools, vision: caps.vision, contextWindow: caps.contextWindow });
  }

  profilesList(): ModelProfile[] {
    return [...this.profiles.values()];
  }

  upsertProfile(p: ModelProfile): void {
    this.profiles.set(p.id, p);
  }

  capabilities(modelId: string): ModelCapabilities {
    const { provider, model } = this.resolve(modelId);
    const caps = provider.capabilities(model);
    const prof = this.profiles.get(modelId);
    return prof ? { ...caps, tools: prof.tools, vision: prof.vision, audio: prof.audio, contextWindow: prof.contextWindow } : caps;
  }
}

export function normalizeProfile(p: Partial<ModelProfile> & { id: string }): ModelProfile {
  return {
    tags: [],
    quality: 0.5,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    latencyMs: 1000,
    contextWindow: 8192,
    tools: true,
    vision: false,
    audio: false,
    json: true,
    lane: 'default',
    enabled: true,
    ...p,
  };
}

/**
 * Resolve a provider's API key from (in order) the config value, an explicit `apiKeyEnv`, the
 * type's conventional env var, and finally ABACUS_API_KEY for ChatLLM.
 *
 * Every candidate is normalized with `|| undefined` so an EMPTY STRING is treated as "not set" and
 * the next source is consulted. This matters because `??` only falls through on null/undefined: a
 * stray `apiKey: ''` in config, or an exported-but-empty `OPENROUTER_API_KEY`, would otherwise win
 * and leave the provider keyless (producing an upstream "Missing Authentication header" 401).
 */
export function resolveProviderApiKey(pc: ProviderConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    (pc.apiKey || undefined) ??
    (pc.apiKeyEnv ? env[pc.apiKeyEnv] || undefined : undefined) ??
    (ENV_KEYS[pc.type] ? env[ENV_KEYS[pc.type]!] || undefined : undefined) ??
    // ChatLLM also accepts the standard Abacus.AI API key.
    (pc.type === 'chatllm' ? env.ABACUS_API_KEY || undefined : undefined)
  );
}

export function createProvider(
  id: string,
  pc: ProviderConfig,
  timeoutMs: number,
  capabilityOverrides?: (model: string) => Partial<ModelCapabilities> | undefined,
): LLMProvider {
  const apiKey = resolveProviderApiKey(pc);
  switch (pc.type) {
    case 'anthropic':
      return new AnthropicProvider({ id, apiKey, baseUrl: pc.baseUrl, timeoutMs });
    case 'openai':
    case 'openrouter':
    case 'lmstudio':
    case 'ollama':
    case 'chatllm':
    case 'openai-compatible': {
      const baseUrl = pc.baseUrl ?? DEFAULT_BASE_URLS[pc.type];
      if (!baseUrl) throw new MercuryError(`Provider "${id}" needs a baseUrl`, 'config_invalid', 'models');
      return new OpenAICompatibleProvider({ id, type: pc.type, baseUrl, apiKey, headers: pc.headers, timeoutMs, capabilityOverrides });
    }
    default:
      throw new MercuryError(`Unknown provider type "${pc.type}" for "${id}"`, 'config_invalid', 'models');
  }
}
