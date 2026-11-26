/**
 * Tests for external secret stores (Tier-2 gap #6), i.e. the core module
 * packages/core/src/secrets/secrets.ts.
 *
 * SCOPE: fully offline and deterministic. The env backend reads from an injected env map; the Bitwarden /
 * 1Password backends run through an INJECTED command runner that records its calls and returns scripted
 * results, so no real CLI is ever spawned. No network, no shell-out.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSecretRef,
  unwrapSecretRef,
  maskSecret,
  envBackend,
  bitwardenBackend,
  onepasswordBackend,
  buildBackends,
  SecretResolver,
  expandSecretsDeep,
  scanSecretRefs,
  secretResolverFromConfig,
  type SecretCommandRunner,
  type SecretRunResult,
} from '../packages/core/src/secrets/secrets.js';

/** A recording runner: scripts responses per "cmd arg0" key and records every invocation. */
function fakeRunner(script: Record<string, SecretRunResult>): { runner: SecretCommandRunner; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const runner: SecretCommandRunner = (cmd, args) => {
    calls.push([cmd, args]);
    const byFull = script[`${cmd} ${args.join(' ')}`];
    if (byFull) return byFull;
    const byVerb = script[`${cmd} ${args[0] ?? ''}`];
    if (byVerb) return byVerb;
    return script[cmd] ?? { ok: false, stdout: '', error: 'no script entry' };
  };
  return { runner, calls };
}

describe('parseSecretRef', () => {
  it('parses backend:key with a known alias', () => {
    expect(parseSecretRef('env:FOO')).toEqual({ backend: 'env', key: 'FOO' });
    expect(parseSecretRef('bw:item')).toEqual({ backend: 'bitwarden', key: 'item' });
    expect(parseSecretRef('op:op://v/i/f')).toEqual({ backend: 'onepassword', key: 'op://v/i/f' });
    expect(parseSecretRef('1password:x')).toEqual({ backend: 'onepassword', key: 'x' });
  });

  it('treats an unknown prefix as part of the key (default backend)', () => {
    expect(parseSecretRef('FOO')).toEqual({ key: 'FOO' });
    // A key that happens to contain a colon but no known backend prefix stays whole.
    expect(parseSecretRef('https://example.com/x')).toEqual({ key: 'https://example.com/x' });
  });

  it('preserves colons in the key for op:// references', () => {
    expect(parseSecretRef('onepassword:op://vault/item/field')).toEqual({ backend: 'onepassword', key: 'op://vault/item/field' });
  });

  it('is case-insensitive on the backend alias', () => {
    expect(parseSecretRef('BW:item')).toEqual({ backend: 'bitwarden', key: 'item' });
  });

  it('throws on an empty spec or a backend with no key', () => {
    expect(() => parseSecretRef('')).toThrow(/empty/);
    expect(() => parseSecretRef('   ')).toThrow(/empty/);
    expect(() => parseSecretRef('env:')).toThrow(/missing a key/);
  });
});

describe('unwrapSecretRef', () => {
  it('strips the ${SECRET:...} wrapper', () => {
    expect(unwrapSecretRef('${SECRET:env:FOO}')).toBe('env:FOO');
    expect(unwrapSecretRef('  ${SECRET:bw:item}  ')).toBe('bw:item');
  });
  it('returns a bare spec unchanged', () => {
    expect(unwrapSecretRef('env:FOO')).toBe('env:FOO');
  });
});

describe('maskSecret', () => {
  it('masks a non-empty value with a fixed width (no length leak)', () => {
    expect(maskSecret('a')).toBe('********');
    expect(maskSecret('a-very-long-super-secret-value')).toBe('********');
    expect(maskSecret('short')).toBe(maskSecret('muchlongervalue'));
  });
  it('returns empty for an empty value', () => {
    expect(maskSecret('')).toBe('');
  });
});

describe('envBackend', () => {
  it('is always available and resolves from the injected env map', () => {
    const b = envBackend({ FOO: 'bar', EMPTY: '' });
    expect(b.available()).toBe(true);
    expect(b.resolve('FOO')).toBe('bar');
  });
  it('returns undefined for a missing or empty variable', () => {
    const b = envBackend({ EMPTY: '' });
    expect(b.resolve('MISSING')).toBeUndefined();
    expect(b.resolve('EMPTY')).toBeUndefined();
  });
});

describe('bitwardenBackend (injected runner)', () => {
  it('resolves via "bw get password <key>" and reports availability', () => {
    const { runner, calls } = fakeRunner({
      'bw --version': { ok: true, stdout: '2024.1.0\n' },
      'bw get': { ok: true, stdout: 's3cr3t\n' },
    });
    const b = bitwardenBackend({ runner });
    expect(b.available()).toBe(true);
    expect(b.resolve('my-item')).toBe('s3cr3t');
    expect(calls).toContainEqual(['bw', ['get', 'password', 'my-item']]);
  });

  it('returns undefined when the CLI fails or the item is missing', () => {
    const { runner } = fakeRunner({ 'bw get': { ok: false, stdout: '', error: 'Not found.' } });
    expect(bitwardenBackend({ runner }).resolve('nope')).toBeUndefined();
  });

  it('reports unavailable when the version probe fails', () => {
    const { runner } = fakeRunner({ 'bw --version': { ok: false, stdout: '', error: 'not installed' } });
    expect(bitwardenBackend({ runner }).available()).toBe(false);
  });

  it('honours a custom command name', () => {
    const { runner, calls } = fakeRunner({ 'bw-wrapper get': { ok: true, stdout: 'v\n' } });
    bitwardenBackend({ runner, command: 'bw-wrapper' }).resolve('k');
    expect(calls[0]![0]).toBe('bw-wrapper');
  });
});

describe('onepasswordBackend (injected runner)', () => {
  it('resolves via "op read <ref>"', () => {
    const { runner, calls } = fakeRunner({
      'op --version': { ok: true, stdout: '2.0.0\n' },
      'op read': { ok: true, stdout: 'tok3n\n' },
    });
    const b = onepasswordBackend({ runner });
    expect(b.available()).toBe(true);
    expect(b.resolve('op://v/i/f')).toBe('tok3n');
    expect(calls).toContainEqual(['op', ['read', 'op://v/i/f']]);
  });

  it('returns undefined on failure', () => {
    const { runner } = fakeRunner({ 'op read': { ok: false, stdout: '', error: 'no item' } });
    expect(onepasswordBackend({ runner }).resolve('op://x/y/z')).toBeUndefined();
  });
});

describe('buildBackends', () => {
  it('always includes env and gates bw/op behind config enablement', () => {
    const { runner } = fakeRunner({});
    expect([...buildBackends({}, { runner }).keys()]).toEqual(['env']);
    const all = buildBackends(
      { bitwarden: { enabled: true }, onepassword: { enabled: true } },
      { runner },
    );
    expect([...all.keys()].sort()).toEqual(['bitwarden', 'env', 'onepassword']);
  });

  it('does not add a backend that is present but disabled', () => {
    const { runner } = fakeRunner({});
    const b = buildBackends({ bitwarden: { enabled: false } }, { runner });
    expect(b.has('bitwarden')).toBe(false);
  });
});

describe('SecretResolver.resolveRef', () => {
  const makeResolver = (): SecretResolver => {
    const { runner } = fakeRunner({
      'bw --version': { ok: true, stdout: '1\n' },
      'bw get': { ok: true, stdout: 'bw-secret\n' },
    });
    return secretResolverFromConfig(
      { defaultBackend: 'env', bitwarden: { enabled: true } },
      { env: { API_KEY: 'live-key' }, runner },
    );
  };

  it('resolves through the default backend for a bare key', () => {
    expect(makeResolver().resolveRef('API_KEY')).toEqual({ ref: { backend: 'env', key: 'API_KEY' }, value: 'live-key' });
  });

  it('resolves through an explicit backend alias', () => {
    expect(makeResolver().resolveRef('bw:item').value).toBe('bw-secret');
  });

  it('throws on a backend that is not configured', () => {
    // op is a known alias, but onepassword is not enabled in this resolver (only env + bitwarden).
    expect(() => makeResolver().resolveRef('op:item')).toThrow(/unknown secret backend/);
  });

  it('throws on an unavailable backend', () => {
    const resolver = secretResolverFromConfig(
      { bitwarden: { enabled: true } },
      { runner: fakeRunner({ 'bw --version': { ok: false, stdout: '' } }).runner },
    );
    expect(() => resolver.resolveRef('bw:item')).toThrow(/not available/);
  });

  it('throws when the key is not found', () => {
    expect(() => makeResolver().resolveRef('NOPE')).toThrow(/secret not found/);
  });
});

describe('SecretResolver.expand — coexistence with ${ENV_VAR}', () => {
  it('expands ${SECRET:...} and leaves bare ${ENV_VAR} placeholders untouched', () => {
    const resolver = secretResolverFromConfig({}, { env: { TOKEN: 'abc123' } });
    const r = resolver.expand('Bearer ${SECRET:env:TOKEN} for ${OTHER_VAR}');
    expect(r.value).toBe('Bearer abc123 for ${OTHER_VAR}');
    expect(r.refs).toHaveLength(1);
    expect(r.refs[0]).toMatchObject({ backend: 'env', key: 'TOKEN', resolved: true });
  });

  it('leaves an unresolved ${SECRET:...} reference in place and records the error', () => {
    const resolver = secretResolverFromConfig({}, { env: {} });
    const r = resolver.expand('${SECRET:env:MISSING}');
    expect(r.value).toBe('${SECRET:env:MISSING}');
    expect(r.refs[0]!.resolved).toBe(false);
    expect(r.refs[0]!.error).toMatch(/not found/);
  });
});

describe('expandSecretsDeep', () => {
  it('recursively expands references in an MCP-server-shaped object', () => {
    const resolver = secretResolverFromConfig({}, { env: { GH_TOKEN: 'ghp_xxx', API: 'k' } });
    const server = {
      transport: 'stdio',
      command: 'mcp-server',
      args: ['--token', '${SECRET:env:API}'],
      env: { GITHUB_TOKEN: '${SECRET:env:GH_TOKEN}', PLAIN: '${KEEP_ME}' },
      enabled: true,
    };
    const { value, refs } = expandSecretsDeep(server, resolver);
    expect(value.env.GITHUB_TOKEN).toBe('ghp_xxx');
    expect(value.args[1]).toBe('k');
    expect(value.env.PLAIN).toBe('${KEEP_ME}'); // ${ENV_VAR} placeholder untouched
    expect(refs.filter((r) => r.resolved)).toHaveLength(2);
    // The original object is not mutated.
    expect(server.env.GITHUB_TOKEN).toBe('${SECRET:env:GH_TOKEN}');
  });
});

describe('scanSecretRefs', () => {
  it('collects deduplicated inner specs across strings/arrays/objects', () => {
    const cfg = {
      a: 'x ${SECRET:env:A} y',
      b: ['${SECRET:bw:item}', '${SECRET:env:A}'],
      c: { d: '${SECRET:op:op://v/i/f}' },
      n: 42,
    };
    expect(scanSecretRefs(cfg)).toEqual(['env:A', 'bw:item', 'op:op://v/i/f']);
  });

  it('scans raw config text too', () => {
    expect(scanSecretRefs('env: { TOKEN: ${SECRET:env:TOKEN} }')).toEqual(['env:TOKEN']);
  });

  it('returns an empty list when there are no references', () => {
    expect(scanSecretRefs({ a: 'plain', b: '${ENV_VAR}' })).toEqual([]);
  });
});
