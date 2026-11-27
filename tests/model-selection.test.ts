/**
 * Automatic provider/model fallback chain (Feature 1) + criteria-based model selection (Feature 2).
 *
 * Pure-unit coverage of the centralized classifier, chain builder and criteria resolver, plus
 * end-to-end coverage through LLMService.chat() with MockProvider fault injection:
 *   - the chain advances to the next entry on an "unavailable"-class error,
 *   - it aborts after exhausting the chain,
 *   - non-fallback-class errors propagate immediately (no silent fallback),
 *   - criteria selection picks the expected (provider, model), including the 'default' catch-all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MercuryConfig, Principal } from '@mercury/core';
import {
  ConfigSchema,
  MercuryError,
  MockProvider,
  ProviderError,
  getFallbackChain,
  isFallbackError,
  selectModelByCriteria,
} from '@mercury/core';
import { makeMercury } from './helpers.js';

/** Build a full MercuryConfig with the given llm overrides (schema fills every default). */
function cfg(llm: Record<string, unknown>): MercuryConfig {
  return ConfigSchema.parse({ llm });
}

describe('isFallbackError (centralized failover classifier)', () => {
  it('falls back on model-not-found / unknown-provider / misconfig (Mercury errors)', () => {
    expect(isFallbackError(new MercuryError('bad id', 'invalid_model', 'models'))).toBe(true);
    expect(isFallbackError(new MercuryError('no provider', 'unknown_provider', 'models'))).toBe(true);
    expect(isFallbackError(new MercuryError('none', 'no_model_configured', 'models'))).toBe(true);
    expect(isFallbackError(new MercuryError('needs baseUrl', 'config_invalid', 'models'))).toBe(true);
    expect(isFallbackError(new MercuryError('breaker', 'circuit_open', 'reliability', 503))).toBe(true);
  });

  it('falls back on bad/missing API key (401/403) and model-not-found (404)', () => {
    expect(isFallbackError(new ProviderError('unauthorized', 401))).toBe(true);
    expect(isFallbackError(new ProviderError('forbidden', 403))).toBe(true);
    expect(isFallbackError(new ProviderError('no such model', 404))).toBe(true);
  });

  it('falls back on rate-limit / overload / upstream 5xx', () => {
    expect(isFallbackError(new ProviderError('rate limited', 429, true))).toBe(true);
    expect(isFallbackError(new ProviderError('unavailable', 503, true))).toBe(true);
    expect(isFallbackError(new ProviderError('overloaded', 529, true))).toBe(true);
    expect(isFallbackError(new ProviderError('bad gateway', 502, true))).toBe(true);
  });

  it('falls back on connection-refused / network errors (no status, retryable)', () => {
    expect(isFallbackError(new ProviderError('network error calling localhost: connection refused', undefined, true))).toBe(true);
  });

  it('does NOT fall back on bad-request / format errors (400/422)', () => {
    expect(isFallbackError(new ProviderError('bad request', 400, false))).toBe(false);
    expect(isFallbackError(new ProviderError('unprocessable', 422, false))).toBe(false);
  });

  it('does NOT fall back on context-overflow or content-policy', () => {
    expect(isFallbackError(new ProviderError('context_length_exceeded: too many tokens', 400))).toBe(false);
    expect(isFallbackError(new ProviderError('request blocked by content policy', 400))).toBe(false);
    expect(isFallbackError(new Error('maximum context length is 8192 tokens'))).toBe(false);
  });

  it('propagates unknown errors (no recognizable unavailable signal)', () => {
    expect(isFallbackError(new Error('something odd happened'))).toBe(false);
  });
});

describe('getFallbackChain', () => {
  it('returns an ordered list of "<provider>/<model>" ids', () => {
    const c = cfg({ fallback: [{ provider: 'openai', model: 'gpt-4o' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }] });
    expect(getFallbackChain(c)).toEqual(['openai/gpt-4o', 'anthropic/claude-haiku-4-5']);
  });

  it('deduplicates by identity (provider+model+baseUrl, case-insensitive) preserving order', () => {
    const c = cfg({
      fallback: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'OpenAI', model: 'GPT-4o' }, // same identity → dropped
        { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://a' },
        { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://b' }, // different baseUrl → kept
      ],
    });
    expect(getFallbackChain(c)).toEqual(['openai/gpt-4o', 'ollama/llama3.1', 'ollama/llama3.1']);
  });

  it('is empty by default (backward compatible)', () => {
    expect(getFallbackChain(cfg({}))).toEqual([]);
  });
});

describe('selectModelByCriteria', () => {
  const routing = [
    { provider: 'anthropic', model: 'claude-sonnet-4-5', criteria: ['code', 'reasoning'] },
    { provider: 'openai', model: 'gpt-4o-mini', criteria: ['fast'] },
    { provider: 'ollama', model: 'llama3.1', criteria: ['private'] },
    { provider: 'chatllm', model: 'route-llm', criteria: ['default'] },
  ];

  it('picks the most specific entry whose criteria are ALL satisfied', () => {
    expect(selectModelByCriteria(cfg({ routing }), { tags: ['code', 'reasoning'] })).toBe('anthropic/claude-sonnet-4-5');
    expect(selectModelByCriteria(cfg({ routing }), { tags: ['fast'] })).toBe('openai/gpt-4o-mini');
    expect(selectModelByCriteria(cfg({ routing }), { tags: ['private'] })).toBe('ollama/llama3.1');
  });

  it('requires EVERY criterion of an entry to be present (AND semantics)', () => {
    // Only 'code' is requested, so the ['code','reasoning'] entry does NOT match → catch-all.
    expect(selectModelByCriteria(cfg({ routing }), { tags: ['code'] })).toBe('chatllm/route-llm');
  });

  it('falls back to the empty/\'default\' catch-all when nothing specific matches', () => {
    expect(selectModelByCriteria(cfg({ routing }), { tags: ['writing'] })).toBe('chatllm/route-llm');
    expect(selectModelByCriteria(cfg({ routing }), {})).toBe('chatllm/route-llm');
  });

  it('treats an empty-criteria entry as the catch-all too', () => {
    const c = cfg({ routing: [{ provider: 'openai', model: 'gpt-4o', criteria: [] }] });
    expect(selectModelByCriteria(c, { tags: ['anything'] })).toBe('openai/gpt-4o');
  });

  it('adds the vision criterion from needsVision', () => {
    const c = cfg({ routing: [{ provider: 'openai', model: 'gpt-4o', criteria: ['vision'] }] });
    expect(selectModelByCriteria(c, { needsVision: true })).toBe('openai/gpt-4o');
    expect(selectModelByCriteria(c, { needsVision: false })).toBeUndefined();
  });

  it('returns undefined when no routing chain is configured (backward compatible)', () => {
    expect(selectModelByCriteria(cfg({}), { tags: ['code'] })).toBeUndefined();
  });
});

describe('LLMService fallback chain (end-to-end, mock fault injection)', () => {
  it('advances to the next chain entry when the primary throws an unavailable-class error', async () => {
    const ctx = await makeMercury({ llm: { defaultModel: 'mock/echo', retries: 0, fallback: [{ provider: 'mock', model: 'react-text' }] } });
    try {
      const p: Principal = await ctx.m.localPrincipal();
      const mock = ctx.m.providers.get('mock') as MockProvider;
      mock.enqueue(
        () => {
          throw new ProviderError('rate limited', 429, true); // primary unavailable → fall back
        },
        { content: 'served by the fallback model' },
      );
      const r = await ctx.m.llm.chat({ principal: p, messages: [{ role: 'user', content: 'hello there' }], model: 'mock/echo' });
      expect(r.modelId).toBe('mock/react-text');
      expect(r.content).toContain('served by the fallback model');
    } finally {
      await ctx.close();
    }
  });

  it('aborts with "All models failed" after exhausting the chain', async () => {
    const ctx = await makeMercury({ llm: { defaultModel: 'mock/echo', retries: 0, fallback: [{ provider: 'mock', model: 'react-text' }] } });
    try {
      const p: Principal = await ctx.m.localPrincipal();
      const mock = ctx.m.providers.get('mock') as MockProvider;
      // Both the primary and the only fallback are unavailable.
      mock.enqueue(
        () => {
          throw new ProviderError('rate limited', 429, true);
        },
        () => {
          throw new ProviderError('service unavailable', 503, true);
        },
      );
      await expect(ctx.m.llm.chat({ principal: p, messages: [{ role: 'user', content: 'hello' }], model: 'mock/echo' })).rejects.toThrow(/All models failed/);
    } finally {
      await ctx.close();
    }
  });

  it('propagates a non-fallback-class error immediately (no silent fallback)', async () => {
    const ctx = await makeMercury({ llm: { defaultModel: 'mock/echo', retries: 0, fallback: [{ provider: 'mock', model: 'react-text' }] } });
    try {
      const p: Principal = await ctx.m.localPrincipal();
      const mock = ctx.m.providers.get('mock') as MockProvider;
      const before = mock.calls.length;
      mock.enqueue(() => {
        throw new ProviderError('bad request', 400, false); // caller's fault → must NOT fall back
      });
      await expect(ctx.m.llm.chat({ principal: p, messages: [{ role: 'user', content: 'hello' }], model: 'mock/echo' })).rejects.toThrow(/bad request/);
      // Exactly one provider call: the fallback model was never tried.
      expect(mock.calls.length).toBe(before + 1);
    } finally {
      await ctx.close();
    }
  });
});

describe('LLMService criteria-based selection (end-to-end)', () => {
  let ctx: Awaited<ReturnType<typeof makeMercury>>;
  let p: Principal;
  beforeAll(async () => {
    ctx = await makeMercury({
      llm: {
        defaultModel: 'auto',
        routing: [
          { provider: 'mock', model: 'react-text', criteria: ['code'] },
          { provider: 'mock', model: 'echo', criteria: ['default'] },
        ],
      },
    });
    p = await ctx.m.localPrincipal();
  });
  afterAll(() => ctx.close());
  beforeEach(() => {
    (ctx.m.providers.get('mock') as MockProvider).calls.length = 0;
  });

  it('routes a code request to the criteria-matched model', async () => {
    const r = await ctx.m.llm.chat({ principal: p, messages: [{ role: 'user', content: 'please refactor this typescript function' }], tags: ['code'] });
    expect(r.modelId).toBe('mock/react-text');
  });

  it('routes a non-matching request to the default catch-all', async () => {
    const r = await ctx.m.llm.chat({ principal: p, messages: [{ role: 'user', content: 'hi' }], tags: ['writing'] });
    expect(r.modelId).toBe('mock/echo');
  });
});
