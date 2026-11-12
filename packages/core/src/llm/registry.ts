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
];

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private profiles = new Map<string, ModelProfile>();

  constructor(private config: MercuryConfig) {
    // The mock provider is NOT registered by default: Mercury requires a real LLM
    // backend (OpenRouter, Ollama, LM Studio, an OpenAI-compatible API, or Anthropic).
    // It is only available for the test-suite / offline development when explicitly
    // opted in via MERCURY_ENABLE_MOCK=1 or a provider of type "mock" in the config.
    const allowMock =
      process.env.MERCURY_ENABLE_MOCK === '1' ||
      Object.values(config.llm.providers).some((p) => p.type === 'mock' && p.enabled);
    if (allowMock) this.register(new MockProvider());
    // Auto-enable cloud providers whose API key is present in the environment.
    for (const [id, env] of Object.entries(ENV_KEYS)) {
      if (process.env[env] && !config.llm.providers[id]) this.register(createProvider(id, { type: id, enabled: true }, config.llm.timeoutMs));
    }
    for (const [id, pc] of Object.entries(config.llm.providers)) {
      if (pc.enabled) this.register(createProvider(id, pc, config.llm.timeoutMs));
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
    enabled: true,
    ...p,
  };
}

export function createProvider(id: string, pc: ProviderConfig, timeoutMs: number): LLMProvider {
  const apiKey = pc.apiKey ?? (pc.apiKeyEnv ? process.env[pc.apiKeyEnv] : undefined) ?? (ENV_KEYS[pc.type] ? process.env[ENV_KEYS[pc.type]!] : undefined);
  switch (pc.type) {
    case 'mock':
      return new MockProvider(id);
    case 'anthropic':
      return new AnthropicProvider({ id, apiKey, baseUrl: pc.baseUrl, timeoutMs });
    case 'openai':
    case 'openrouter':
    case 'lmstudio':
    case 'ollama':
    case 'openai-compatible': {
      const baseUrl = pc.baseUrl ?? DEFAULT_BASE_URLS[pc.type];
      if (!baseUrl) throw new MercuryError(`Provider "${id}" needs a baseUrl`, 'config_invalid', 'models');
      return new OpenAICompatibleProvider({ id, type: pc.type, baseUrl, apiKey, headers: pc.headers, timeoutMs });
    }
    default:
      throw new MercuryError(`Unknown provider type "${pc.type}" for "${id}"`, 'config_invalid', 'models');
  }
}
