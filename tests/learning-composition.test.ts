/**
 * Tests for the 1.1.1 additions: learning (experience hints, auto-tuned routing, failure
 * playbooks), skill composition (recursion guard + cache), curated MCP presets, the gated
 * web_read tool, and the deeper planner-executor workflow. Fully offline/deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch, type Principal } from '@mercury/core';
import { directToolContext } from '@mercury/runtime';
import { extractMainContent } from '@mercury/tools';
import { mcpPreset, mcpPresets, resolvePreset } from '@mercury/mcp';
import { makeMercury } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeMercury>>;
let p: Principal;
beforeAll(async () => {
  ctx = await makeMercury({ learning: { enabled: true } }, { startServices: true });
  p = await ctx.m.localPrincipal();
});
afterAll(() => ctx.close());

// Insert a completed run row directly so the learning service has history to learn from.
let n = 0;
function seedRun(input: string, output: string, model: string, status = 'completed', userId = p.userId): string {
  const id = `run_test_${++n}`;
  ctx.m.db.run(
    'INSERT INTO runs (id, user_id, session_id, kind, status, input, output, model, pattern, depth, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, userId, 's1', 'agent', status, input, output, model, 'react', 0, new Date().toISOString(),
  );
  return id;
}

describe('learning: experience hints (1a)', () => {
  it('returns undefined when there is no similar past run (graceful empty case)', () => {
    const hint = ctx.m.learning.hintFor('completely unrelated zzzqqq topic nobody did', p.userId);
    expect(hint).toBeUndefined();
  });

  it('injects a hint distilled from a similar past successful run', () => {
    seedRun('write a python script to parse csv files', 'Used the csv module and DictReader to parse rows.', 'mock/fast');
    const hint = ctx.m.learning.hintFor('write a python script to parse csv data', p.userId);
    expect(hint).toBeDefined();
    expect(hint!.text).toContain('Learned from past runs');
    expect(hint!.sources.length).toBeGreaterThan(0);
    expect(hint!.sources[0]!.similarity).toBeGreaterThan(0);
  });
});

describe('learning: auto-tuned routing (1b)', () => {
  it('suggests nothing until there are enough samples (fallback to economics)', () => {
    const svc = ctx.m.learning;
    svc.recordFailure('x', 'y'); // unrelated; no route stats yet
    expect(svc.suggest('medium', ['mock/fast', 'mock/smart'])).toBeNull();
  });

  it('prefers the model with the best observed success rate once samples accumulate', () => {
    const { m } = ctx;
    // Feed observed outcomes via run.end-style recording by inserting runs + replaying.
    for (let i = 0; i < 6; i++) {
      const good = seedRun('medium difficulty analysis task number ' + i, 'ok', 'mock/smart', 'completed');
      m.bus.emit({ type: 'run.end', runId: good, userId: p.userId, data: { status: 'completed', usage: { cost: 0.01 } } } as never);
    }
    // The stat is bucketed by the task's inferred difficulty — find whichever bucket it landed in.
    const stats = m.learning.routeStats().find((s) => s.model === 'mock/smart');
    expect(stats).toBeDefined();
    expect(stats!.runs).toBeGreaterThanOrEqual(5);
    const suggestion = m.learning.suggest(stats!.bucket, ['mock/fast', 'mock/smart']);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.model).toBe('mock/smart');
  });
});

describe('learning: failure playbooks (1c)', () => {
  it('stores and retrieves a failure playbook by error signature', () => {
    const pb = ctx.m.learning.recordFailure('deploy the service', 'Error: ECONNREFUSED 127.0.0.1:5432 while connecting');
    expect(pb.occurrences).toBeGreaterThanOrEqual(1);
    const again = ctx.m.learning.recordFailure('deploy the other service', 'Error: ECONNREFUSED 10.0.0.2:5432 while connecting');
    expect(again.occurrences).toBe(2); // same normalised signature
    const found = ctx.m.learning.playbookForError('Error: ECONNREFUSED 192.168.1.9:5432 while connecting');
    expect(found).toBeDefined();
    expect(found!.signature).toBe(again.signature);
  });

  it('exposes playbooks for listing', () => {
    expect(ctx.m.learning.playbooks(10).length).toBeGreaterThan(0);
  });
});

describe('skill composition (2a)', () => {
  it('runs a composition of tool steps and caches the result', async () => {
    const tctx = directToolContext(ctx.m, p, 'cli');
    const spec = { skill: 'calc-combo', steps: [{ tool: 'calculator', args: { expression: '2+2' }, label: 'a' }] };
    ctx.m.composer.clearCache();
    const r1 = await ctx.m.composer.run(spec, tctx);
    expect(r1.cached).toBe(false);
    expect(r1.steps[0]!.output).toContain('4');
    const r2 = await ctx.m.composer.run(spec, tctx);
    expect(r2.cached).toBe(true);
  });

  it('rejects a composition that cycles back to an active skill (recursion guard)', async () => {
    const tctx = directToolContext(ctx.m, p, 'cli');
    const spec = { skill: 'loop', steps: [{ skill: 'loop', steps: [] }] };
    await expect(ctx.m.composer.run(spec, tctx)).rejects.toThrow(/cycle/i);
  });
});

describe('MCP presets (2b)', () => {
  it('registers curated presets with documented env placeholders and no secrets', () => {
    const names = mcpPresets().map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['filesystem', 'fetch', 'github', 'git', 'sqlite']));
    const github = mcpPreset('github');
    expect(github).toBeDefined();
    expect(JSON.stringify(github)).not.toMatch(/ghp_|secret/i);
  });

  it('resolves placeholders from env and reports missing vars', () => {
    const github = mcpPreset('github')!;
    const missing = resolvePreset(github, {});
    expect(missing.missingEnv).toContain('GITHUB_TOKEN');
    const ok = resolvePreset(github, { GITHUB_TOKEN: 'tkn-123' });
    expect(ok.missingEnv).toHaveLength(0);
    expect(JSON.stringify(ok.config)).toContain('tkn-123');
  });
});

describe('gated web_read tool (2c)', () => {
  it('is registered, risk-tagged and approval-gated', () => {
    const tool = ctx.m.tools.list().find((t) => t.name === 'web_read');
    expect(tool).toBeDefined();
    expect(tool!.risk).toBe('moderate');
    expect(tool!.sensitive).toBe(true);
  });

  it('extracts readable main content from HTML (happy path)', () => {
    const html = '<html><head><title>Hello</title></head><body><nav>menu</nav><main><p>The main article body text here.</p></main><footer>foot</footer></body></html>';
    const { title, text } = extractMainContent(html);
    expect(title).toBe('Hello');
    expect(text).toContain('main article body text');
    expect(text).not.toContain('menu');
  });

  it('blocks SSRF to private/loopback addresses', async () => {
    await expect(safeFetch('http://127.0.0.1:5432/')).rejects.toThrow(/private|blocked/i);
    await expect(safeFetch('http://localhost/')).rejects.toThrow(/internal|blocked/i);
  });
});

describe('planner-executor workflow (deeper runs)', () => {
  it('runs at least the configured minimum number of steps', async () => {
    const spec = {
      name: 'deep-dive-test',
      type: 'planner-executor',
      options: { minSteps: 4, targetSteps: 4, maxSteps: 8 },
      agents: [{ name: 'planner', role: 'plan' }, { name: 'executor', role: 'do' }, { name: 'synthesizer', role: 'combine' }],
    };
    const r = await ctx.m.workflows.run(spec, 'analyse the market and write a plan', { principal: p, platform: 'cli' });
    const execSteps = r.steps.filter((s) => s.agent === 'executor');
    expect(execSteps.length).toBeGreaterThanOrEqual(4);
    expect(r.output.length).toBeGreaterThan(0);
  });
});
