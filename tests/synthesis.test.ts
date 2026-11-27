/**
 * Offline, deterministic tests for self-extending tools / dynamic tool synthesis (new gap).
 *
 * The whole subsystem is DISABLED BY DEFAULT and intensely safety-gated, so these tests cover each
 * gate: threshold-based gap detection, authoring + draft parsing, the validation gate (accept + reject
 * on manifest / compile / test), approval gating (pending / approve / deny / auto-approve), capability
 * policy (deny-by-default, host allow-list), provenance/audit, persistence/reload roundtrip, the
 * disabled-no-op behaviour, and config parsing.
 *
 * Two kinds of runner are exercised:
 *   - STUBBED compile/test runners for the pure flow (deterministic, no process) — the bulk below.
 *   - the REAL out-of-process compile/test runners (`makeCompileRunner`/`makeTestRunner` from
 *     @mercury/tools) against good and bad Python/Node drafts — proving the generated-test mechanism
 *     actually runs the authored unit test in a child process before registration.
 *
 * HONESTY: these tests exercise the pure logic with injected stubs plus the real LOCAL host
 * compile/test runners. The quality of drafts produced by a real production LLM, and execution inside
 * the full polyglot/Docker host sandbox at USE time, are NOT exercised here.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  Synthesizer,
  SynthRegistry,
  GapTracker,
  gapKey,
  defaultSynthesisPolicy,
  checkManifest,
  hostAllowed,
  checkDraftShape,
  emptyManifest,
  buildAuthoringPrompt,
  parseDraft,
  extractJsonObject,
  validateDraft,
  runtimeCommand,
  buildToolManifest,
  persistToolFolder,
  removeToolFolder,
  loadPersistedRecords,
  loadRegistry,
  SYNTH_META_FILE,
  SYNTH_DISABLED,
  type SynthesisPolicy,
  type SynthesizedToolDraft,
  type SynthesizedToolRecord,
  type RunnerOutput,
  type ValidatorDeps,
} from '@mercury/core';
import { makeCompileRunner, makeTestRunner, makeSynthRunners } from '@mercury/tools';

// ─────────────────────────────── helpers ───────────────────────────────

function pyDraft(over: Partial<SynthesizedToolDraft> = {}): SynthesizedToolDraft {
  return {
    name: 'add_numbers',
    description: 'Add two numbers',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    runtime: 'python',
    code: [
      'import sys, json',
      'def run(args):',
      '    return args["a"] + args["b"]',
      'if __name__ == "__main__":',
      '    a = json.loads(sys.stdin.read() or "{}")',
      '    print(json.dumps({"content": str(run(a)), "isError": False}))',
    ].join('\n'),
    test: [
      'from main import run',
      'assert run({"a": 2, "b": 3}) == 5, "2+3 should be 5"',
      'assert run({"a": -1, "b": 1}) == 0',
      'print("ok")',
    ].join('\n'),
    capabilities: emptyManifest(),
    ...over,
  };
}

function enabledPolicy(over: Partial<SynthesisPolicy> = {}): SynthesisPolicy {
  return { ...defaultSynthesisPolicy(), enabled: true, missThreshold: 3, ...over };
}

const okRunner = (): RunnerOutput => ({ ok: true, output: 'ok' });
const failRunner = (): RunnerOutput => ({ ok: false, output: 'boom' });
const okDeps: ValidatorDeps = { compile: okRunner, test: okRunner };

function stubLlm(draft: SynthesizedToolDraft): () => Promise<string> {
  return async () => JSON.stringify(draft);
}

function record(over: Partial<SynthesizedToolRecord> = {}): SynthesizedToolRecord {
  return {
    id: 'synth_1',
    draft: pyDraft(),
    provenance: { actor: 'system', gapKey: 'add_numbers', trigger: 'need add', author: 'llm', createdAt: '2026-01-01T00:00:00Z' },
    validation: { ok: true, stage: 'passed', errors: [] },
    approval: 'pending',
    invocations: 0,
    ...over,
  };
}

// ─────────────────────────────── gap detection ───────────────────────────────

describe('gap detection — gapKey + GapTracker', () => {
  it('normalizes capability signatures to a stable key', () => {
    expect(gapKey('fetchWeather')).toBe('fetchweather');
    expect(gapKey('  Fetch Weather  ')).toBe('fetch_weather');
    expect(gapKey('fetch-weather!!')).toBe('fetch_weather');
    expect(gapKey('')).toBe('unknown');
    expect(gapKey('a'.repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it('collapses equivalent requests to the same counter', () => {
    const t = new GapTracker(() => '2026-01-01T00:00:00Z');
    t.record('fetch weather');
    t.record('fetch_weather');
    expect(t.count('Fetch   Weather')).toBe(2);
  });

  it('only triggers at or above the threshold, clamped to >= 1', () => {
    const t = new GapTracker();
    t.record('x');
    expect(t.shouldTrigger('x', 3)).toBe(false);
    t.record('x');
    t.record('x');
    expect(t.shouldTrigger('x', 3)).toBe(true);
    // threshold 0 must not auto-fire on a single miss of a different gap
    const t2 = new GapTracker();
    t2.record('y');
    expect(t2.shouldTrigger('y', 0)).toBe(true); // clamp makes 1 miss enough at threshold 1
    expect(t2.shouldTrigger('never-seen', 0)).toBe(false);
  });

  it('reset clears a single counter; list is most-missed first', () => {
    const t = new GapTracker();
    t.record('a'); t.record('a'); t.record('b');
    expect(t.list().map((m) => m.key)).toEqual(['a', 'b']);
    t.reset('a');
    expect(t.count('a')).toBe(0);
    expect(t.list().map((m) => m.key)).toEqual(['b']);
  });
});

// ─────────────────────────────── policy (deny-by-default) ───────────────────────────────

describe('capability policy — deny-by-default', () => {
  it('default policy grants nothing and is disabled', () => {
    const p = defaultSynthesisPolicy();
    expect(p.enabled).toBe(false);
    expect(p.allowFilesystem || p.allowNetwork || p.allowShell).toBe(false);
    expect(p.missThreshold).toBe(3);
  });

  it('rejects filesystem/network/shell unless explicitly granted', () => {
    const p = defaultSynthesisPolicy();
    expect(checkManifest({ filesystem: true, network: 'none', hosts: [], shell: false }, p).ok).toBe(false);
    expect(checkManifest({ filesystem: false, network: 'allow', hosts: ['x.com'], shell: false }, p).ok).toBe(false);
    expect(checkManifest({ filesystem: false, network: 'none', hosts: [], shell: true }, p).ok).toBe(false);
  });

  it('networked tool must declare hosts, all within the allowlist', () => {
    const p = enabledPolicy({ allowNetwork: true, allowedHosts: ['api.example.com', '*.trusted.io'] });
    expect(checkManifest({ filesystem: false, network: 'allow', hosts: [], shell: false }, p).ok).toBe(false); // empty hosts
    expect(checkManifest({ filesystem: false, network: 'allow', hosts: ['evil.com'], shell: false }, p).ok).toBe(false);
    expect(checkManifest({ filesystem: false, network: 'allow', hosts: ['api.example.com', 'a.trusted.io'], shell: false }, p).ok).toBe(true);
  });

  it('hosts declared without network:allow is a violation', () => {
    const p = enabledPolicy({ allowNetwork: true, allowedHosts: ['x.com'] });
    expect(checkManifest({ filesystem: false, network: 'none', hosts: ['x.com'], shell: false }, p).ok).toBe(false);
  });

  it('hostAllowed matches exact and *.suffix wildcards only', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('a.trusted.io', ['*.trusted.io'])).toBe(true);
    expect(hostAllowed('trusted.io', ['*.trusted.io'])).toBe(false); // bare apex not covered by wildcard
    expect(hostAllowed('evil.com', ['*.trusted.io', 'api.example.com'])).toBe(false);
  });

  it('checkDraftShape enforces name regex, runtime and required fields', () => {
    const p = enabledPolicy();
    expect(checkDraftShape(pyDraft(), p)).toEqual([]);
    expect(checkDraftShape(pyDraft({ name: 'Bad-Name' }), p).some((e) => e.includes('invalid tool name'))).toBe(true);
    expect(checkDraftShape(pyDraft({ name: 'ab' }), p).some((e) => e.includes('invalid tool name'))).toBe(true);
    expect(checkDraftShape(pyDraft({ code: '  ' }), p).some((e) => e.includes('code is empty'))).toBe(true);
    expect(checkDraftShape(pyDraft({ test: '' }), p).some((e) => e.includes('test is empty'))).toBe(true);
    const restricted = enabledPolicy({ runtimes: ['node'] });
    expect(checkDraftShape(pyDraft(), restricted).some((e) => e.includes('not permitted by policy.runtimes'))).toBe(true);
  });
});

// ─────────────────────────────── authoring ───────────────────────────────

describe('authoring — prompt + draft parsing', () => {
  it('buildAuthoringPrompt names the capability and the grant limits', () => {
    const prompt = buildAuthoringPrompt({
      capability: 'fetch weather',
      context: 'user asked for weather',
      allowedRuntimes: ['python'],
      grantable: { filesystem: false, network: true, hosts: ['api.weather.com'], shell: false },
    });
    expect(prompt).toContain('fetch weather');
    expect(prompt).toContain('network allowed   : true');
    expect(prompt).toContain('api.weather.com');
    expect(prompt).toContain('shell allowed     : false');
  });

  it('extractJsonObject tolerates fences, prose and nested braces', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('here you go: {"a":{"b":2}} trailing')).toBe('{"a":{"b":2}}');
    expect(extractJsonObject('{"s":"a}b"}')).toBe('{"s":"a}b"}'); // brace inside a string
    expect(extractJsonObject('no json here')).toBeUndefined();
  });

  it('parseDraft accepts a well-formed draft and fills manifest defaults', () => {
    const r = parseDraft(JSON.stringify(pyDraft({ capabilities: undefined as never })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.name).toBe('add_numbers');
      expect(r.draft.capabilities).toEqual(emptyManifest());
    }
  });

  it('parseDraft reports structural errors rather than throwing', () => {
    expect(parseDraft('not json at all').ok).toBe(false);
    expect(parseDraft('{"name":"x"}').ok).toBe(false); // missing runtime/code/test
    const bad = parseDraft('{ broken json');
    expect(bad.ok).toBe(false);
  });
});

// ─────────────────────────────── validation gate ───────────────────────────────

describe('validation gate — accept + reject by stage', () => {
  it('passes a clean draft through manifest → compile → test', async () => {
    const res = await validateDraft(pyDraft(), enabledPolicy(), okDeps);
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('passed');
  });

  it('rejects at manifest stage for an over-privileged draft (never compiles it)', async () => {
    let compiled = false;
    const deps: ValidatorDeps = { compile: () => { compiled = true; return okRunner(); }, test: okRunner };
    const res = await validateDraft(pyDraft({ capabilities: { filesystem: true, network: 'none', hosts: [], shell: false } }), enabledPolicy(), deps);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('manifest');
    expect(compiled).toBe(false);
  });

  it('rejects at compile stage (never runs the test)', async () => {
    let tested = false;
    const deps: ValidatorDeps = { compile: failRunner, test: () => { tested = true; return okRunner(); } };
    const res = await validateDraft(pyDraft(), enabledPolicy(), deps);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('compile');
    expect(tested).toBe(false);
  });

  it('rejects at test stage when the generated test fails', async () => {
    const res = await validateDraft(pyDraft(), enabledPolicy(), { compile: okRunner, test: failRunner });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('test');
    expect(res.testOutput).toBe('boom');
  });

  it('captures a thrown runner as a stage failure (never throws)', async () => {
    const deps: ValidatorDeps = { compile: () => { throw new Error('spawn ENOENT'); }, test: okRunner };
    const res = await validateDraft(pyDraft(), enabledPolicy(), deps);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('compile');
    expect(res.compileOutput).toContain('spawn ENOENT');
  });
});

// ─────────────────────────────── registry + persistence ───────────────────────────────

describe('registry — lifecycle + polyglot mapping', () => {
  it('add/get/byName/list and approve/deny transitions', () => {
    const reg = new SynthRegistry();
    reg.add(record());
    expect(reg.get('synth_1')?.draft.name).toBe('add_numbers');
    expect(reg.byName('add_numbers')?.id).toBe('synth_1');
    expect(reg.list({ approval: 'pending' })).toHaveLength(1);
    reg.approve('synth_1', 'alice', '2026-01-02T00:00:00Z');
    expect(reg.get('synth_1')?.approval).toBe('approved');
    expect(reg.get('synth_1')?.decidedBy).toBe('alice');
    reg.deny('synth_1', 'bob', '2026-01-03T00:00:00Z');
    expect(reg.get('synth_1')?.approval).toBe('denied');
    expect(reg.recordInvocation('synth_1')).toBe(1);
  });

  it('runtimeCommand + buildToolManifest map capabilities to sandbox controls', () => {
    expect(runtimeCommand(pyDraft())).toEqual({ command: ['python3', 'main.py'], file: 'main.py' });
    expect(runtimeCommand(pyDraft({ runtime: 'node' }))).toEqual({ command: ['node', 'main.mjs'], file: 'main.mjs' });
    const safe = buildToolManifest(pyDraft(), { timeoutMs: 1000 });
    expect(safe.risk).toBe('safe');
    expect(safe.network).toBe(false);
    expect(safe.workdir).toBe('none');
    expect(safe.untrustedOutput).toBe(true);
    const net = buildToolManifest(pyDraft({ capabilities: { filesystem: false, network: 'allow', hosts: ['x.com'], shell: false } }), { timeoutMs: 1000 });
    expect(net.risk).toBe('moderate');
    expect(net.network).toBe(true);
    const sh = buildToolManifest(pyDraft({ capabilities: { filesystem: true, network: 'none', hosts: [], shell: true } }), { timeoutMs: 1000 });
    expect(sh.risk).toBe('dangerous');
    expect(sh.workdir).toBe('rw');
  });

  it('persist → load roundtrip; refuses to persist a non-approved tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-synth-reg-'));
    try {
      expect(() => persistToolFolder(dir, record(), { timeoutMs: 1000 })).toThrow(/non-approved/);
      const approved = record({ approval: 'approved', decidedBy: 'alice', decidedAt: '2026-01-02T00:00:00Z' });
      const folder = persistToolFolder(dir, approved, { timeoutMs: 1000 });
      expect(existsSync(join(folder, 'tool.json'))).toBe(true);
      expect(existsSync(join(folder, 'main.py'))).toBe(true);
      expect(existsSync(join(folder, SYNTH_META_FILE))).toBe(true);

      const loaded = loadPersistedRecords(dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.draft.name).toBe('add_numbers');

      const reg = loadRegistry(dir);
      expect(reg.byName('add_numbers')?.approval).toBe('approved');

      removeToolFolder(dir, 'add_numbers');
      expect(existsSync(folder)).toBe(false);
      expect(loadPersistedRecords(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadPersistedRecords skips a corrupt metadata folder without crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-synth-corrupt-'));
    try {
      const approved = record({ approval: 'approved' });
      persistToolFolder(dir, approved, { timeoutMs: 1000 });
      // write a second folder with broken metadata
      const bad = join(dir, 'broken');
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, SYNTH_META_FILE), '{ not json');
      expect(loadPersistedRecords(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── synthesizer (orchestrator) ───────────────────────────────

describe('Synthesizer — disabled-by-default no-op', () => {
  const disabled = () => new Synthesizer({ policy: defaultSynthesisPolicy(), llm: stubLlm(pyDraft()), validator: okDeps });

  it('every entry point is a hard no-op when disabled', async () => {
    const s = disabled();
    expect(s.isEnabled()).toBe(false);
    expect(s.recordMiss('x')).toEqual({ triggered: false, count: 0 });
    const out = await s.synthesize({ capability: 'x' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe(SYNTH_DISABLED);
    expect(s.approve('whatever').reason).toBe(SYNTH_DISABLED);
    expect(s.deny('whatever').reason).toBe(SYNTH_DISABLED);
    expect(s.list()).toEqual([]);
    expect(s.gaps()).toEqual([]);
  });
});

describe('Synthesizer — full flow (enabled, stubbed LLM + runners)', () => {
  it('recordMiss triggers only at threshold', () => {
    const s = new Synthesizer({ policy: enabledPolicy({ missThreshold: 2 }), llm: stubLlm(pyDraft()), validator: okDeps });
    expect(s.recordMiss('fetch weather').triggered).toBe(false);
    expect(s.recordMiss('fetch_weather').triggered).toBe(true);
  });

  it('synthesize authors + validates → a PENDING record (never auto-runs)', async () => {
    const audit: string[] = [];
    const s = new Synthesizer({
      policy: enabledPolicy(),
      llm: stubLlm(pyDraft()),
      validator: okDeps,
      idGen: () => 'synth_fixed',
      audit: (action) => audit.push(action),
    });
    const out = await s.synthesize({ capability: 'add numbers', actor: 'alice' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.record.approval).toBe('pending');
      expect(out.record.provenance.actor).toBe('alice');
      expect(out.record.validation.ok).toBe(true);
    }
    expect(audit).toContain('synth.created');
  });

  it('autoApprove produces an approved record only when validation passes', async () => {
    const s = new Synthesizer({ policy: enabledPolicy({ autoApprove: true }), llm: stubLlm(pyDraft()), validator: okDeps, idGen: () => 'a' });
    const out = await s.synthesize({ capability: 'add' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.record.approval).toBe('approved');
      expect(out.record.decidedBy).toBe('policy.autoApprove');
    }
  });

  it('a failing validation yields a non-ok outcome but still records the attempt', async () => {
    const s = new Synthesizer({ policy: enabledPolicy(), llm: stubLlm(pyDraft()), validator: { compile: failRunner, test: okRunner }, idGen: () => 'r' });
    const out = await s.synthesize({ capability: 'add' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain('validation failed at compile');
      expect(out.record?.validation.ok).toBe(false);
      expect(out.record?.approval).toBe('pending');
    }
    // the record is retained so an admin can inspect why it failed
    expect(s.list()).toHaveLength(1);
  });

  it('an over-privileged draft is rejected at the manifest gate', async () => {
    const draft = pyDraft({ capabilities: { filesystem: true, network: 'none', hosts: [], shell: false } });
    const s = new Synthesizer({ policy: enabledPolicy(), llm: stubLlm(draft), validator: okDeps, idGen: () => 'r' });
    const out = await s.synthesize({ capability: 'write files' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('manifest');
  });

  it('approve requires a validated, non-denied tool; deny is permanent', async () => {
    const s = new Synthesizer({ policy: enabledPolicy(), llm: stubLlm(pyDraft()), validator: okDeps, idGen: () => 'id1' });
    await s.synthesize({ capability: 'add' });
    expect(s.approve('missing').ok).toBe(false);
    const ap = s.approve('id1', 'alice');
    expect(ap.ok).toBe(true);
    expect(ap.record?.approval).toBe('approved');
    // deny after approve
    const dn = s.deny('id1', 'bob');
    expect(dn.ok).toBe(true);
    expect(dn.record?.approval).toBe('denied');
    // cannot re-approve a denied tool
    expect(s.approve('id1').ok).toBe(false);
  });

  it('approve re-checks the manifest against the CURRENT (possibly tightened) policy', async () => {
    // author under a permissive policy that grants network
    const draft = pyDraft({ capabilities: { filesystem: false, network: 'allow', hosts: ['api.example.com'], shell: false } });
    const policy = enabledPolicy({ allowNetwork: true, allowedHosts: ['api.example.com'] });
    const s = new Synthesizer({ policy, llm: stubLlm(draft), validator: okDeps, idGen: () => 'id1' });
    const out = await s.synthesize({ capability: 'call api' });
    expect(out.ok).toBe(true);
    // tighten the policy: network no longer allowed
    policy.allowNetwork = false;
    const ap = s.approve('id1');
    expect(ap.ok).toBe(false);
    expect(ap.reason).toContain('no longer permitted');
  });
});

// ─────────────────────────────── config parsing ───────────────────────────────

describe('config — selfExtension section', () => {
  it('defaults are safe (disabled, nothing granted, threshold 3)', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.selfExtension.enabled).toBe(false);
    expect(cfg.selfExtension.missThreshold).toBe(3);
    expect(cfg.selfExtension.autoApprove).toBe(false);
    expect(cfg.selfExtension.allowFilesystem).toBe(false);
    expect(cfg.selfExtension.allowNetwork).toBe(false);
    expect(cfg.selfExtension.allowShell).toBe(false);
    expect(cfg.selfExtension.allowedHosts).toEqual([]);
    expect(cfg.selfExtension.runtimes).toEqual(['python', 'node']);
    expect(cfg.selfExtension.timeoutMs).toBe(15_000);
    expect(cfg.selfExtension.maxOutputChars).toBe(20_000);
  });

  it('accepts overrides and rejects an invalid threshold', () => {
    const cfg = ConfigSchema.parse({ selfExtension: { enabled: true, missThreshold: 5, allowNetwork: true, allowedHosts: ['api.x.com'], runtimes: ['python'] } });
    expect(cfg.selfExtension.enabled).toBe(true);
    expect(cfg.selfExtension.missThreshold).toBe(5);
    expect(cfg.selfExtension.allowedHosts).toEqual(['api.x.com']);
    expect(cfg.selfExtension.runtimes).toEqual(['python']);
    expect(() => ConfigSchema.parse({ selfExtension: { missThreshold: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ selfExtension: { missThreshold: -1 } })).toThrow();
  });
});

// ─────────────────────────────── REAL out-of-process runners ───────────────────────────────

describe('real runners — generated-test mechanism runs out-of-process (python)', () => {
  it('compile runner accepts valid python and rejects a syntax error', async () => {
    const compile = makeCompileRunner({ timeoutMs: 20_000 });
    expect((await compile(pyDraft())).ok).toBe(true);
    const bad = await compile(pyDraft({ code: 'def run(args)\n    return 1' })); // missing colon
    expect(bad.ok).toBe(false);
  });

  it('test runner passes a correct impl and fails a wrong impl (via the generated test)', async () => {
    const test = makeTestRunner({ timeoutMs: 20_000 });
    expect((await test(pyDraft())).ok).toBe(true);
    // impl returns a-b instead of a+b → the generated assert 2+3==5 fails
    const wrong = await test(pyDraft({ code: [
      'import sys, json',
      'def run(args):',
      '    return args["a"] - args["b"]',
      'if __name__ == "__main__":',
      '    print(json.dumps({"content": "x", "isError": False}))',
    ].join('\n') }));
    expect(wrong.ok).toBe(false);
  });

  it('full gate (validateDraft) passes with the REAL runners on a good python draft', async () => {
    const res = await validateDraft(pyDraft(), enabledPolicy(), makeSynthRunners({ timeoutMs: 20_000 }));
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('passed');
  });

  it('a long-running impl is killed by the timeout', async () => {
    const test = makeTestRunner({ timeoutMs: 1000 });
    const slow = await test(pyDraft({
      code: 'import time\ndef run(args):\n    time.sleep(30)\n    return 1',
      test: 'from main import run\nrun({"a":1,"b":2})\n',
    }));
    expect(slow.ok).toBe(false);
    expect(slow.output).toContain('timed out');
  }, 20_000);
});

describe('real runners — node runtime', () => {
  it('compiles and tests a valid node draft', async () => {
    const draft = pyDraft({
      name: 'nadd',
      runtime: 'node',
      code: [
        'export function run(args) { return args.a + args.b; }',
        'if (import.meta.url === `file://${process.argv[1]}`) {',
        '  let s = ""; process.stdin.on("data", d => s += d);',
        '  process.stdin.on("end", () => { const a = JSON.parse(s || "{}"); process.stdout.write(JSON.stringify({ content: String(run(a)), isError: false })); });',
        '}',
      ].join('\n'),
      test: [
        'import { run } from "./main.mjs";',
        'import assert from "node:assert";',
        'assert.strictEqual(run({ a: 2, b: 3 }), 5);',
        'console.log("ok");',
      ].join('\n'),
    });
    expect((await makeCompileRunner({ timeoutMs: 20_000 })(draft)).ok).toBe(true);
    expect((await makeTestRunner({ timeoutMs: 20_000 })(draft)).ok).toBe(true);
  }, 25_000);
});
