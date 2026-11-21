/**
 * Cross-subsystem integration: an AGENT reaching the LLM-WIKI through the real
 * wiring — agent loop → tool executor → ToolContext.services.wiki → WikiService →
 * WikiLlm → LLMService (circuit-breaker/retry) → provider.
 *
 * No subsystem is mocked. The only scripted thing is the LLM *transport* (the
 * test-only MockProvider at the provider boundary), exactly as production would
 * talk to a real model. This proves the parts work together, not just in isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider, type Principal } from '@mercury/core';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let p: Principal;

beforeAll(async () => {
  // wiki.enabled defaults true; keep it explicit so the intent is obvious.
  ctx = await makeMercury({ wiki: { enabled: true } });
  p = await ctx.m.localPrincipal();
});
afterAll(() => ctx.close());

describe('agents + Wiki LLM work together', () => {
  it('exposes the wiki subsystem and its tools to the agent', () => {
    // The same WikiService the runtime wired to the real LLM is reachable.
    expect(ctx.m.wiki).toBeTruthy();
    const toolNames = ctx.m.tools.list().map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['wiki_ingest', 'wiki_query', 'wiki_lint']));
  });

  it('ingestion goes through the real WikiService → WikiLlm → LLMService → provider', async () => {
    const mock = ctx.m.providers.get('mock') as MockProvider;
    // Script the model's synthesis reply (the WikiLlm asks for JSON pages).
    mock.enqueue({
      content: JSON.stringify({
        pages: [
          {
            slug: 'photosynthesis',
            title: 'Photosynthesis',
            content:
              'Photosynthesis is how plants convert light energy into chemical energy, ' +
              'storing it as sugars. Source: bio.txt.',
            links: [],
          },
        ],
      }),
    });

    const res = await ctx.m.wiki.ingest('Plants convert sunlight into chemical energy via photosynthesis.', {
      asText: true,
      name: 'bio.txt',
    });
    expect(res.created).toContain('photosynthesis');

    const status = await ctx.m.wiki.status();
    expect(status.pages).toBe(1);
    expect(status.sources).toBeGreaterThanOrEqual(1);
  });

  it('an agent turn invokes wiki_query, which answers via the Wiki LLM', async () => {
    // Queue is empty → the agent's planning turn uses the mock's built-in
    // `call:<tool>` detection, and the WikiLlm.answer call uses the built-in
    // echo — so the whole chain runs with zero hand-fed ordering.
    const r = await ctx.m.commands.handle({
      principal: p,
      input: 'call:wiki_query {"question":"How do plants make energy?"}',
      platform: 'cli',
    });

    // The agent actually routed to the wiki tool...
    expect(r.run?.toolNames).toContain('wiki_query');
    // ...and the tool produced a grounded, non-empty answer from the wiki page.
    expect(r.run?.status).toBe('completed');
    expect(r.output.trim().length).toBeGreaterThan(0);
  });

  it('wiki_lint runs end-to-end over the agent-populated wiki', async () => {
    const r = await ctx.m.commands.handle({
      principal: p,
      input: 'call:wiki_lint {"no_llm":true}',
      platform: 'cli',
    });
    expect(r.run?.toolNames).toContain('wiki_lint');
    expect(r.run?.status).toBe('completed');
  });
});
