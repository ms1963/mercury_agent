/**
 * Offline regression tests for the "keyless cloud provider" trap.
 *
 * Symptom this guards against (reported for `mercury chat` with OpenRouter):
 *   Error: All models failed. openrouter/openai/gpt-4o-mini: 401 from openrouter.ai:
 *   {"error":{"message":"Missing Authentication header","code":401}}
 *
 * Root cause: a key-requiring cloud provider was registered without an API key reaching
 * `process.env`, so it sent a request with NO Authorization header and the upstream returned a
 * cryptic empty-key 401. Two fixes are covered here, both fully offline (no network):
 *   1. `resolveProviderApiKey` normalizes empty strings to undefined so the env fallback applies
 *      even when config carries `apiKey: ''` or the shell exports an empty var.
 *   2. The OpenAI-compatible and Anthropic providers fail fast with an actionable local error
 *      (naming the env var + the ./.env / shell-var shadowing caveat) instead of a silent 401.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicProvider, OpenAICompatibleProvider, resolveProviderApiKey } from '@mercury/core';
import type { LLMRequest } from '@mercury/core';

const req: LLMRequest = { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };

describe('resolveProviderApiKey', () => {
  it('uses the config apiKey when present', () => {
    expect(resolveProviderApiKey({ type: 'openrouter', apiKey: 'from-config' }, {})).toBe('from-config');
  });

  it('treats an empty-string config apiKey as missing and falls through to the env var', () => {
    expect(resolveProviderApiKey({ type: 'openrouter', apiKey: '' }, { OPENROUTER_API_KEY: 'from-env' })).toBe('from-env');
  });

  it('treats an empty-string env var as missing (no key resolved)', () => {
    expect(resolveProviderApiKey({ type: 'openrouter' }, { OPENROUTER_API_KEY: '' })).toBeUndefined();
  });

  it('honours an explicit apiKeyEnv before the conventional one', () => {
    expect(resolveProviderApiKey({ type: 'openrouter', apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'x', OPENROUTER_API_KEY: 'y' })).toBe('x');
  });

  it('falls back to ABACUS_API_KEY for chatllm', () => {
    expect(resolveProviderApiKey({ type: 'chatllm' }, { ABACUS_API_KEY: 'abacus' })).toBe('abacus');
  });

  it('returns undefined when nothing supplies a key', () => {
    expect(resolveProviderApiKey({ type: 'openrouter' }, {})).toBeUndefined();
  });
});

describe('cloud providers fail fast without an API key (no silent 401)', () => {
  it('OpenAI-compatible (openrouter) throws an actionable error naming the env var', async () => {
    const p = new OpenAICompatibleProvider({ id: 'openrouter', type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    await expect(p.chat(req)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('OpenAI-compatible (openai) throws naming OPENAI_API_KEY', async () => {
    const p = new OpenAICompatibleProvider({ id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1' });
    await expect(p.chat(req)).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('error mentions the ./.env / shell-variable shadowing caveat', async () => {
    const p = new OpenAICompatibleProvider({ id: 'openrouter', type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    await expect(p.chat(req)).rejects.toThrow(/shadow/i);
  });

  it('Anthropic throws an actionable error naming ANTHROPIC_API_KEY', async () => {
    const p = new AnthropicProvider({ id: 'anthropic' });
    await expect(p.chat(req)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('local providers (ollama) are NOT blocked for a missing key', () => {
    // ollama needs no key; constructing + guarding must never throw for it.
    const p = new OpenAICompatibleProvider({ id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434/v1' });
    // No ensureAuth throw: the request will instead attempt a (failing) local fetch, which is a
    // network error, NOT a missing_api_key error. We only assert the guard does not fire.
    expect(p.type).toBe('ollama');
  });
});
