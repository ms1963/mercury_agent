/**
 * Tests for the supply-chain audit engine (`mercury security audit` / @mercury/core supply-chain).
 *
 * SCOPE: fully offline and deterministic. Every OSV.dev interaction goes through a FAKE injected
 * HttpClient returning canned responses — no real network call is made. The real OSV.dev service is
 * NEVER contacted by this suite (that is only exercised by the manual CLI smoke run).
 *
 * Covers: npm lockfile coordinate extraction (v1/v2/v3), MCP server -> npm coordinate mapping,
 * plugin coordinate extraction, version-spec normalisation, OSV querybatch + /v1/vulns parsing
 * (vulnerable AND clean cases), report shaping, and exit-code logic.
 */
import { describe, expect, it } from 'vitest';
import {
  auditCoordinates,
  coordinatesFromPackageJson,
  dedupe,
  exactVersion,
  exitCodeFor,
  extractFixedVersion,
  extractNpmCoordinates,
  extractSeverity,
  mcpServerCoordinates,
  npmPackageFromCommand,
  parseBatchResponse,
  pluginCoordinates,
  type Coordinate,
  type HttpClient,
  type HttpResponse,
} from '@mercury/core';

// --------------------------------------------------------------------------------------------------
// A fake OSV HTTP client: canned querybatch + /v1/vulns/{id} responses, zero network.
// --------------------------------------------------------------------------------------------------

interface FakeOsvOptions {
  /** Map of "name@version" (or "name" when unpinned) -> vulnerability ids returned by querybatch. */
  vulnsByCoord?: Record<string, string[]>;
  /** Map of vuln id -> full OSV vuln object returned by GET /v1/vulns/{id}. */
  details?: Record<string, unknown>;
  /** Force querybatch to fail with this HTTP status (to exercise the error path). */
  batchStatus?: number;
}

function fakeOsvClient(opts: FakeOsvOptions): { http: HttpClient; calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  const json = (value: unknown, ok = true, status = 200): HttpResponse => ({ ok, status, json: () => Promise.resolve(value) });
  const http: HttpClient = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.endsWith('/v1/querybatch')) {
      if (opts.batchStatus) return Promise.resolve(json({}, false, opts.batchStatus));
      const body = JSON.parse(init?.body ?? '{}') as { queries: { package: { name: string }; version?: string }[] };
      const results = body.queries.map((q) => {
        const key = q.version ? `${q.package.name}@${q.version}` : q.package.name;
        const ids = opts.vulnsByCoord?.[key] ?? [];
        return { vulns: ids.map((id) => ({ id })) };
      });
      return Promise.resolve(json({ results }));
    }
    const m = /\/v1\/vulns\/(.+)$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const detail = opts.details?.[id];
      return Promise.resolve(detail ? json(detail) : json({ message: 'not found' }, false, 404));
    }
    return Promise.resolve(json({}, false, 400));
  };
  return { http, calls };
}

// --------------------------------------------------------------------------------------------------
// npm lockfile coordinate extraction
// --------------------------------------------------------------------------------------------------

describe('extractNpmCoordinates', () => {
  it('parses a lockfile v3 `packages` map, skipping the root and links, handling scoped names', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/@scope/pkg': { version: '2.3.4' },
        'node_modules/a/node_modules/lodash': { version: '4.17.20' }, // duplicate -> deduped
        'node_modules/linked': { version: '9.9.9', link: true }, // symlink -> skipped
        'node_modules/noversion': {}, // no version -> skipped
      },
    };
    const coords = extractNpmCoordinates(JSON.stringify(lock));
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'lodash', version: '4.17.20', source: 'npm' });
    expect(coords).toContainEqual({ ecosystem: 'npm', name: '@scope/pkg', version: '2.3.4', source: 'npm' });
    expect(coords.filter((c) => c.name === 'lodash')).toHaveLength(1); // deduped
    expect(coords.find((c) => c.name === 'root')).toBeUndefined();
    expect(coords.find((c) => c.name === 'linked')).toBeUndefined();
    expect(coords.find((c) => c.name === 'noversion')).toBeUndefined();
  });

  it('parses a legacy lockfile v1 `dependencies` tree recursively', () => {
    const lock = {
      lockfileVersion: 1,
      dependencies: {
        express: { version: '4.18.2', dependencies: { 'body-parser': { version: '1.20.1' } } },
      },
    };
    const coords = extractNpmCoordinates(JSON.stringify(lock));
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'express', version: '4.18.2', source: 'npm' });
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'body-parser', version: '1.20.1', source: 'npm' });
  });

  it('throws a clear error on malformed JSON', () => {
    expect(() => extractNpmCoordinates('{not json')).toThrow(/invalid package-lock\.json/);
  });
});

// --------------------------------------------------------------------------------------------------
// version normalisation
// --------------------------------------------------------------------------------------------------

describe('exactVersion', () => {
  it('normalises exact-ish specs and rejects ranges/tags/protocols', () => {
    expect(exactVersion('1.2.3')).toBe('1.2.3');
    expect(exactVersion('^1.2.3')).toBe('1.2.3');
    expect(exactVersion('~1.2.3')).toBe('1.2.3');
    expect(exactVersion('=1.2.3')).toBe('1.2.3');
    expect(exactVersion('v1.2.3')).toBe('1.2.3');
    expect(exactVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(exactVersion('*')).toBe('');
    expect(exactVersion('latest')).toBe('');
    expect(exactVersion('>=1.0.0 <2.0.0')).toBe('');
    expect(exactVersion('workspace:*')).toBe('');
    expect(exactVersion('file:../local')).toBe('');
    expect(exactVersion(undefined)).toBe('');
  });
});

// --------------------------------------------------------------------------------------------------
// MCP server -> coordinate mapping
// --------------------------------------------------------------------------------------------------

describe('mcpServerCoordinates / npmPackageFromCommand', () => {
  it('derives the npm package from an npx command, stripping version tags and keeping scopes', () => {
    expect(npmPackageFromCommand({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('@playwright/mcp');
    expect(npmPackageFromCommand({ command: 'npx', args: ['-y', 'obsidian-mcp@2', 'serve'] })).toBe('obsidian-mcp');
    expect(npmPackageFromCommand({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] })).toBe('@modelcontextprotocol/server-slack');
    expect(npmPackageFromCommand({ command: 'uvx', args: ['mcp-server-git'] })).toBeUndefined(); // not npm
    expect(npmPackageFromCommand({ command: 'npx', args: ['-y'] })).toBeUndefined(); // no package
  });

  it('maps configured servers to coordinates, respecting enabled state and pinning from installed versions', () => {
    const servers = {
      slack: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], enabled: true },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: true },
      git: { command: 'uvx', args: ['mcp-server-git'], enabled: true }, // non-npm -> skipped
      off: { command: 'npx', args: ['-y', 'some-pkg'], enabled: false }, // disabled -> skipped by default
    };
    const installed = new Map([['@modelcontextprotocol/server-slack', '0.6.2']]);
    const coords = mcpServerCoordinates(servers, installed);
    expect(coords).toContainEqual({ ecosystem: 'npm', name: '@modelcontextprotocol/server-slack', version: '0.6.2', source: 'mcp', via: 'slack' });
    // unpinned (not installed) -> empty version
    expect(coords).toContainEqual({ ecosystem: 'npm', name: '@playwright/mcp', version: '', source: 'mcp', via: 'playwright' });
    expect(coords.find((c) => c.name === 'mcp-server-git')).toBeUndefined();
    expect(coords.find((c) => c.name === 'some-pkg')).toBeUndefined();
  });

  it('includes disabled servers when includeDisabled is set', () => {
    const servers = { off: { command: 'npx', args: ['-y', 'some-pkg'], enabled: false } };
    expect(mcpServerCoordinates(servers, new Map(), true)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------------------------------
// plugin coordinate extraction
// --------------------------------------------------------------------------------------------------

describe('pluginCoordinates / coordinatesFromPackageJson', () => {
  it('extracts the plugin itself plus its declared dependencies', () => {
    const coords = coordinatesFromPackageJson(
      { name: 'my-plugin', version: '1.0.0', dependencies: { axios: '^1.6.0' }, optionalDependencies: { chalk: '5.3.0' } },
      'plugin',
    );
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'my-plugin', version: '1.0.0', source: 'plugin', via: 'my-plugin' });
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'axios', version: '1.6.0', source: 'plugin', via: 'my-plugin' });
    expect(coords).toContainEqual({ ecosystem: 'npm', name: 'chalk', version: '5.3.0', source: 'plugin', via: 'my-plugin' });
  });

  it('maps installed plugins to coordinates and dedupes, skipping plugins without a package.json', () => {
    const coords = pluginCoordinates([
      { name: 'p1', pkgJson: { name: 'p1', version: '0.1.0', dependencies: { lodash: '4.17.21' } } },
      { name: 'p2', pkgJson: { name: 'p2', version: '0.2.0', dependencies: { lodash: '4.17.21' } } },
      { name: 'p3' }, // no package.json -> contributes nothing
    ]);
    expect(coords.find((c) => c.name === 'p1')).toBeTruthy();
    expect(coords.find((c) => c.name === 'p2')).toBeTruthy();
    // lodash@4.17.21 appears via both plugins but dedupes into a single coordinate (merged via)
    const lodash = coords.filter((c) => c.name === 'lodash');
    expect(lodash).toHaveLength(1);
    expect(lodash[0]!.via).toContain('p1');
    expect(lodash[0]!.via).toContain('p2');
  });
});

// --------------------------------------------------------------------------------------------------
// OSV response parsing (pure)
// --------------------------------------------------------------------------------------------------

describe('OSV parsing helpers', () => {
  it('parseBatchResponse maps each query slot to its vuln ids (padding missing slots)', () => {
    const json = { results: [{ vulns: [{ id: 'GHSA-aaaa' }, { id: 'GHSA-bbbb' }] }, {}] };
    expect(parseBatchResponse(json, 3)).toEqual([['GHSA-aaaa', 'GHSA-bbbb'], [], []]);
  });

  it('extractSeverity prefers database_specific.severity then falls back to a CVSS score', () => {
    expect(extractSeverity({ id: 'x', database_specific: { severity: 'HIGH' } })).toBe('HIGH');
    expect(extractSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] })).toBe('CVSS_V3:CVSS:3.1/AV:N');
    expect(extractSeverity({ id: 'x' })).toBeUndefined();
  });

  it('extractFixedVersion collects fixed events for the matching package, highest first', () => {
    const vuln = {
      id: 'x',
      affected: [
        { package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] },
        { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ events: [{ fixed: '9.9.9' }] }] },
      ],
    };
    expect(extractFixedVersion(vuln, 'lodash')).toBe('4.17.21');
    expect(extractFixedVersion({ id: 'x', affected: [] }, 'lodash')).toBeUndefined();
  });
});

// --------------------------------------------------------------------------------------------------
// audit engine: vulnerable, clean, error + report shaping + exit codes
// --------------------------------------------------------------------------------------------------

describe('auditCoordinates (fake OSV client)', () => {
  const coords: Coordinate[] = [
    { ecosystem: 'npm', name: 'lodash', version: '4.17.20', source: 'npm' },
    { ecosystem: 'npm', name: 'safe-pkg', version: '1.0.0', source: 'npm' },
    { ecosystem: 'npm', name: '@playwright/mcp', version: '', source: 'mcp', via: 'playwright' },
  ];

  it('reports vulnerabilities with enriched details and status "vulnerable"', async () => {
    const { http, calls } = fakeOsvClient({
      vulnsByCoord: { 'lodash@4.17.20': ['GHSA-lodash-1'], '@playwright/mcp': ['GHSA-pw-1'] },
      details: {
        'GHSA-lodash-1': {
          id: 'GHSA-lodash-1',
          aliases: ['CVE-2021-23337'],
          summary: 'Command injection in lodash',
          database_specific: { severity: 'HIGH' },
          affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
        },
        'GHSA-pw-1': { id: 'GHSA-pw-1', summary: 'Playwright MCP issue' },
      },
    });
    const report = await auditCoordinates(coords, { http, osvBaseUrl: 'https://osv.test' });

    expect(report.status).toBe('vulnerable');
    expect(report.ok).toBe(true);
    expect(report.scanned).toBe(3);
    expect(report.vulnerablePackages).toBe(2);
    expect(report.findings).toHaveLength(2);
    expect(report.sources.sort()).toEqual(['mcp', 'npm']);

    const lodash = report.findings.find((f) => f.coordinate.name === 'lodash')!;
    expect(lodash.id).toBe('GHSA-lodash-1');
    expect(lodash.aliases).toContain('CVE-2021-23337');
    expect(lodash.severity).toBe('HIGH');
    expect(lodash.fixedVersion).toBe('4.17.21');

    // querybatch called once (<=1000), details fetched once per unique id.
    expect(calls.filter((c) => c.url.endsWith('/v1/querybatch'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/v1/vulns/'))).toHaveLength(2);
    expect(exitCodeFor(report.status)).toBe(1);
  });

  it('reports a clean result (status "clean", exit 0) when OSV returns no vulns', async () => {
    const { http, calls } = fakeOsvClient({ vulnsByCoord: {} });
    const report = await auditCoordinates(coords, { http });
    expect(report.status).toBe('clean');
    expect(report.findings).toHaveLength(0);
    expect(report.vulnerablePackages).toBe(0);
    expect(report.ok).toBe(true);
    expect(exitCodeFor(report.status)).toBe(0);
    // no vulns => no detail calls
    expect(calls.filter((c) => c.url.includes('/v1/vulns/'))).toHaveLength(0);
  });

  it('distinguishes "could not complete" (status "error", exit 2) on a querybatch network failure', async () => {
    const { http } = fakeOsvClient({ batchStatus: 503 });
    const report = await auditCoordinates(coords, { http });
    expect(report.status).toBe('error');
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it('still reports the finding (and records an error) when enrichment of a vuln id fails', async () => {
    const { http } = fakeOsvClient({ vulnsByCoord: { 'lodash@4.17.20': ['GHSA-missing'] }, details: {} });
    const report = await auditCoordinates(coords, { http });
    expect(report.status).toBe('vulnerable');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.summary).toBe('(details unavailable)');
    expect(report.errors.some((e) => e.includes('GHSA-missing'))).toBe(true);
  });

  it('returns a clean empty report without any HTTP call when there are no coordinates', async () => {
    const { http, calls } = fakeOsvClient({});
    const report = await auditCoordinates([], { http });
    expect(report.status).toBe('clean');
    expect(report.scanned).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('batches querybatch into chunks of batchSize', async () => {
    const many: Coordinate[] = Array.from({ length: 5 }, (_, i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0', source: 'npm' }));
    const { http, calls } = fakeOsvClient({ vulnsByCoord: {} });
    await auditCoordinates(many, { http, batchSize: 2 });
    expect(calls.filter((c) => c.url.endsWith('/v1/querybatch'))).toHaveLength(3); // 2 + 2 + 1
  });
});

describe('dedupe', () => {
  it('merges via labels for identical source+name+version coordinates', () => {
    const merged = dedupe([
      { ecosystem: 'npm', name: 'x', version: '1.0.0', source: 'plugin', via: 'a' },
      { ecosystem: 'npm', name: 'x', version: '1.0.0', source: 'plugin', via: 'b' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.via).toBe('a, b');
  });
});
