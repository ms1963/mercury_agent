/** Provider registry: ChatLLM and other OpenAI-compatible backends. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, DEFAULT_BASE_URLS, ProviderRegistry, createProvider } from '@mercury/core';

function config(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({ llm: { defaultModel: 'auto', providers: {}, models: [] }, ...overrides });
}

describe('ChatLLM provider', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CHATLLM_API_KEY;
    delete process.env.ABACUS_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the Abacus.AI RouteLLM endpoint by default', () => {
    expect(DEFAULT_BASE_URLS.chatllm).toBe('https://routellm.abacus.ai/v1');
  });

  it('builds a chatllm provider via the OpenAI-compatible transport', () => {
    const p = createProvider('chatllm', { type: 'chatllm', apiKey: 'test-key', enabled: true }, 30_000);
    expect(p.id).toBe('chatllm');
    expect(p.type).toBe('chatllm');
  });

  it('auto-enables chatllm when CHATLLM_API_KEY is present', () => {
    process.env.CHATLLM_API_KEY = 'k';
    const reg = new ProviderRegistry(config());
    expect(reg.get('chatllm')).toBeDefined();
    const { provider, model } = reg.resolve('chatllm/route-llm');
    expect(provider.id).toBe('chatllm');
    expect(model).toBe('route-llm');
  });

  it('also accepts ABACUS_API_KEY as the ChatLLM key', () => {
    process.env.ABACUS_API_KEY = 'k';
    const reg = new ProviderRegistry(config({ llm: { defaultModel: 'auto', providers: { chatllm: { type: 'chatllm', enabled: true } }, models: [] } }));
    expect(reg.get('chatllm')).toBeDefined();
  });

  it('registers built-in chatllm model profiles', () => {
    process.env.CHATLLM_API_KEY = 'k';
    const reg = new ProviderRegistry(config());
    const ids = reg.profilesList().map((p) => p.id);
    expect(ids).toContain('chatllm/route-llm');
  });
});
