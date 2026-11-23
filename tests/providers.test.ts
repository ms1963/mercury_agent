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

  // Regression: the provider's own wire builder must see the profile's vision flag, not just
  // a name guess. "route-llm" has no vision keyword, so without capability overrides the
  // provider dropped images (and told the user it "can't view the image"), even though the
  // router happily routed to it as vision-capable.
  it('propagates profile vision capability to the provider (route-llm images are not dropped)', () => {
    process.env.CHATLLM_API_KEY = 'k';
    const reg = new ProviderRegistry(config());
    const provider = reg.get('chatllm')!;
    // Name guess alone does not know route-llm is vision-capable...
    expect(provider.capabilities('route-llm').vision).toBe(true); // ...but the profile override does.
    expect(reg.capabilities('chatllm/route-llm').vision).toBe(true);

    const img = { id: 'att_1', name: 'x.png', mime: 'image/png', size: 3, kind: 'image' as const, data: Buffer.from('abc').toString('base64') };
    const wire = (provider as unknown as { toWire(req: { model: string; messages: unknown[] }): Array<{ content: unknown }> }).toWire({
      model: 'route-llm',
      messages: [{ role: 'user', content: 'what is this?', attachments: [img] }],
    });
    const content = wire[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>).some((part) => part.type === 'image_url')).toBe(true);
  });
});
