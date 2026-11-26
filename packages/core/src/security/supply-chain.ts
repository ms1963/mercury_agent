/**
 * Supply-chain vulnerability audit over the free OSV.dev API (https://osv.dev).
 *
 * This module is self-contained and side-effect free at import time: it performs NO network calls,
 * reads NO files and holds NO secrets. The HTTP client is injected (see {@link HttpClient}) so the
 * test suite can exercise query/response parsing with canned OSV responses and never touch the
 * network. The CLI (`mercury security audit`) wires in a real `fetch`-backed client.
 *
 * What it audits (coordinate sources):
 *  - `npm`    — packages enumerated from a package-lock.json (lockfile v1, v2 and v3).
 *  - `mcp`    — npm packages invoked by configured/enabled MCP servers (e.g. `npx -y <pkg>`).
 *  - `plugin` — installed plugins and the npm dependencies they declare in their package.json.
 *
 * OSV is queried in batches via POST /v1/querybatch (efficient, one round-trip per ≤1000 coords);
 * each distinct vulnerability id is then enriched via GET /v1/vulns/{id} for summary, aliases,
 * severity and fixed-in version. Network/parse failures are collected into the report rather than
 * thrown, and the report carries a tri-state status so a caller can distinguish "clean" from
 * "could not complete".
 */

/** Where a coordinate was discovered, so findings can be grouped/labelled by origin. */
export type AuditSource = 'npm' | 'mcp' | 'plugin';

/** A single package coordinate to check against OSV. */
export interface Coordinate {
  /** OSV ecosystem, e.g. "npm". */
  ecosystem: string;
  /** Package name, e.g. "lodash" or "@scope/pkg". */
  name: string;
  /** Exact installed version, or "" when the version is unpinned (e.g. an `npx`-run MCP server). */
  version: string;
  /** Which audit source surfaced this coordinate. */
  source: AuditSource;
  /** Optional human context, e.g. the MCP server name or plugin that pulled the package in. */
  via?: string;
}

/** A vulnerability finding attached to one coordinate. */
export interface VulnFinding {
  coordinate: Coordinate;
  /** Primary OSV id (GHSA-… or similar). */
  id: string;
  /** Cross-reference ids (CVE-…, etc.). */
  aliases: string[];
  /** Short human summary (may be empty if OSV provided none or enrichment failed). */
  summary: string;
  /** Severity label if OSV supplied one (e.g. "HIGH" or a CVSS vector), else undefined. */
  severity?: string;
  /** Fixed-in version(s) if OSV listed any, joined by ", ", else undefined. */
  fixedVersion?: string;
}

/** Overall audit outcome. */
export type AuditStatus = 'clean' | 'vulnerable' | 'error';

/** The typed audit report returned by {@link auditCoordinates}. */
export interface SupplyChainReport {
  generatedAt: string;
  /** Sources represented in the audited coordinate set. */
  sources: AuditSource[];
  /** Number of coordinates submitted for audit. */
  totalPackages: number;
  /** Distinct package@version (or package when unpinned) coordinates actually queried. */
  scanned: number;
  findings: VulnFinding[];
  /** Count of distinct coordinates that have at least one finding. */
  vulnerablePackages: number;
  /** Non-fatal problems (a failed batch, a failed enrichment, a missing lockfile upstream, …). */
  errors: string[];
  /** True when the audit completed without a fatal data-gathering failure. */
  ok: boolean;
  status: AuditStatus;
}

/** Minimal response shape the injected client must return (a subset of the Fetch Response). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable HTTP client; defaults to a global-`fetch`-backed implementation in the CLI. */
export type HttpClient = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<HttpResponse>;

/** Options for {@link auditCoordinates}. */
export interface SupplyChainAuditOptions {
  /** Injected HTTP client. Defaults to {@link fetchHttpClient} (real network). */
  http?: HttpClient;
  /** OSV API base URL (no trailing slash). Defaults to https://api.osv.dev. */
  osvBaseUrl?: string;
  /** Max coordinates per querybatch call. Defaults to 1000 (OSV's batch guidance). */
  batchSize?: number;
}

const DEFAULT_OSV_BASE = 'https://api.osv.dev';
const DEFAULT_BATCH = 1000;

/** A real `fetch`-backed {@link HttpClient}. Node >= 18 provides a global `fetch`. */
export const fetchHttpClient: HttpClient = async (url, init) => {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

// --------------------------------------------------------------------------------------------------
// Coordinate extraction (pure, no network, no fs)
// --------------------------------------------------------------------------------------------------

interface LockfileV2Package {
  version?: string;
  link?: boolean;
  dev?: boolean;
  resolved?: string;
}
interface LockfileV1Dependency {
  version?: string;
  dependencies?: Record<string, LockfileV1Dependency>;
}
interface LockfileShape {
  lockfileVersion?: number;
  packages?: Record<string, LockfileV2Package>;
  dependencies?: Record<string, LockfileV1Dependency>;
}

/** Extract the npm package name from a `node_modules/...` lockfile key (handles scoped packages). */
function nameFromLockKey(key: string): string | undefined {
  const idx = key.lastIndexOf('node_modules/');
  if (idx === -1) return undefined;
  const name = key.slice(idx + 'node_modules/'.length);
  return name || undefined;
}

/**
 * Parse a package-lock.json (as text or object) into deduped npm coordinates. Supports lockfile
 * v2/v3 (the `packages` map) and the legacy v1 (`dependencies` tree). Local links and the root
 * project entry are skipped; only entries with a concrete version are returned.
 */
export function extractNpmCoordinates(lockfile: string | LockfileShape): Coordinate[] {
  let lock: LockfileShape;
  try {
    lock = typeof lockfile === 'string' ? (JSON.parse(lockfile) as LockfileShape) : lockfile;
  } catch (err) {
    throw new Error(`invalid package-lock.json: ${(err as Error).message}`);
  }
  const seen = new Map<string, Coordinate>();
  const add = (name: string | undefined, version: string | undefined) => {
    if (!name || !version) return;
    const key = `${name}@${version}`;
    if (!seen.has(key)) seen.set(key, { ecosystem: 'npm', name, version, source: 'npm' });
  };

  if (lock.packages && Object.keys(lock.packages).length) {
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (key === '' || pkg.link) continue; // root project / symlinked workspace
      add(nameFromLockKey(key), pkg.version);
    }
  }
  // v1 (and belt-and-braces for anything only present in the legacy tree).
  const walk = (deps: Record<string, LockfileV1Dependency> | undefined) => {
    if (!deps) return;
    for (const [name, dep] of Object.entries(deps)) {
      add(name, dep.version);
      walk(dep.dependencies);
    }
  };
  walk(lock.dependencies);

  return [...seen.values()];
}

/** A package.json-ish object as read from a plugin directory. */
export interface PackageJsonLike {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Turn an npm version range/spec into an exact version for OSV, or "" when it is not an exact pin.
 * `^1.2.3`/`~1.2.3`/`=1.2.3`/`v1.2.3` → `1.2.3`; ranges, tags, `*`, `latest`, `workspace:`,
 * `file:`, `link:`, git/url specs → "" (unpinned; OSV is then queried by name only).
 */
export function exactVersion(spec: string | undefined): string {
  if (!spec) return '';
  const s = spec.trim();
  if (!s || s === '*' || s === 'latest' || s === 'x') return '';
  if (/^(workspace|file|link|git|github|npm|https?):/i.test(s)) return '';
  const m = /^[v=~^]?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(s);
  return m ? m[1]! : '';
}

/** Extract coordinates (the package itself + its declared deps) from one package.json object. */
export function coordinatesFromPackageJson(pkg: PackageJsonLike, source: AuditSource, via?: string): Coordinate[] {
  const out: Coordinate[] = [];
  const label = via ?? pkg.name;
  if (pkg.name && pkg.version) out.push({ ecosystem: 'npm', name: pkg.name, version: exactVersion(pkg.version), source, via: label });
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const [name, spec] of Object.entries(deps)) out.push({ ecosystem: 'npm', name, version: exactVersion(spec), source, via: label });
  return out;
}

/** An installed plugin plus the package.json found alongside it (read by the caller). */
export interface PluginPkg {
  name: string;
  pkgJson?: PackageJsonLike;
}

/** Extract npm coordinates declared by installed plugins (self + dependencies). */
export function pluginCoordinates(plugins: PluginPkg[]): Coordinate[] {
  const out: Coordinate[] = [];
  for (const p of plugins) {
    if (p.pkgJson) out.push(...coordinatesFromPackageJson(p.pkgJson, 'plugin', p.name));
  }
  return dedupe(out);
}

/** A configured MCP server (the relevant subset of McpServerConfig). */
export interface McpServerLike {
  command?: string;
  args?: string[];
  enabled?: boolean;
}

/**
 * Derive the npm package name an MCP server invokes, or undefined when it is not an npm/npx server.
 * Handles `npx -y <pkg>` / `npx <pkg>` and strips any version/tag suffix (keeping scoped names).
 */
export function npmPackageFromCommand(server: McpServerLike): string | undefined {
  if (server.command !== 'npx') return undefined;
  const args = server.args ?? [];
  const spec = args.find((a) => a && !a.startsWith('-'));
  if (!spec) return undefined;
  return stripVersionTag(spec);
}

/** `@scope/pkg@1.2.3` → `@scope/pkg`; `pkg@latest` → `pkg`; `pkg` → `pkg`. */
function stripVersionTag(spec: string): string {
  const scoped = spec.startsWith('@');
  const at = spec.indexOf('@', scoped ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * Map configured MCP servers to npm coordinates. MCP servers are usually launched on demand via
 * `npx` and are therefore not pinned in the repo lockfile; when `installedVersions` contains the
 * package (because it also appears in node_modules) that exact version is used, otherwise the
 * coordinate is left unpinned (version "") and OSV is queried by package name only.
 *
 * By default only enabled servers are included; pass `includeDisabled` to audit every configured
 * server regardless of state.
 */
export function mcpServerCoordinates(
  servers: Record<string, McpServerLike>,
  installedVersions: Map<string, string> = new Map(),
  includeDisabled = false,
): Coordinate[] {
  const out: Coordinate[] = [];
  for (const [serverName, server] of Object.entries(servers)) {
    if (!includeDisabled && server.enabled === false) continue;
    const pkg = npmPackageFromCommand(server);
    if (!pkg) continue;
    out.push({ ecosystem: 'npm', name: pkg, version: installedVersions.get(pkg) ?? '', source: 'mcp', via: serverName });
  }
  return dedupe(out);
}

/** Deduplicate coordinates by source+name+version, merging `via` labels. */
export function dedupe(coords: Coordinate[]): Coordinate[] {
  const seen = new Map<string, Coordinate>();
  for (const c of coords) {
    const key = `${c.source}|${c.ecosystem}|${c.name}@${c.version}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { ...c });
    else if (c.via && prev.via && !prev.via.split(', ').includes(c.via)) prev.via = `${prev.via}, ${c.via}`;
  }
  return [...seen.values()];
}

// --------------------------------------------------------------------------------------------------
// OSV response parsing (pure)
// --------------------------------------------------------------------------------------------------

interface OsvBatchResult {
  vulns?: { id: string; modified?: string }[];
}
interface OsvBatchResponse {
  results?: OsvBatchResult[];
}
interface OsvSeverity {
  type?: string;
  score?: string;
}
interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}
interface OsvAffected {
  package?: { ecosystem?: string; name?: string };
  ranges?: OsvRange[];
  severity?: OsvSeverity[];
  database_specific?: { severity?: string };
}
interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  database_specific?: { severity?: string };
}

/** Parse a /v1/querybatch response into a per-query array of vulnerability-id lists. */
export function parseBatchResponse(json: unknown, expected: number): string[][] {
  const results = (json as OsvBatchResponse)?.results ?? [];
  const out: string[][] = [];
  for (let i = 0; i < expected; i++) {
    const r = results[i];
    out.push(r?.vulns?.map((v) => v.id).filter(Boolean) ?? []);
  }
  return out;
}

/** Extract a human severity label from a full OSV vuln, scoped to a package name when possible. */
export function extractSeverity(vuln: OsvVuln, pkgName?: string): string | undefined {
  if (vuln.database_specific?.severity) return vuln.database_specific.severity;
  const affected = pkgName ? vuln.affected?.find((a) => a.package?.name === pkgName) : undefined;
  if (affected?.database_specific?.severity) return affected.database_specific.severity;
  const sev = vuln.severity?.[0] ?? affected?.severity?.[0];
  if (sev?.score) return sev.type ? `${sev.type}:${sev.score}` : sev.score;
  return undefined;
}

/** Collect fixed-in versions for a package from a full OSV vuln, highest first, joined by ", ". */
export function extractFixedVersion(vuln: OsvVuln, pkgName: string): string | undefined {
  const fixes = new Set<string>();
  for (const a of vuln.affected ?? []) {
    if (a.package?.name && a.package.name !== pkgName) continue;
    for (const r of a.ranges ?? []) {
      for (const e of r.events ?? []) if (e.fixed) fixes.add(e.fixed);
    }
  }
  if (!fixes.size) return undefined;
  return [...fixes].sort(compareVersionsDesc).join(', ');
}

/** Descending semver-ish comparison good enough for ordering fixed-in versions. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Build a {@link VulnFinding} from a coordinate and an enriched OSV vuln. */
export function toFinding(coordinate: Coordinate, vuln: OsvVuln): VulnFinding {
  return {
    coordinate,
    id: vuln.id,
    aliases: vuln.aliases ?? [],
    summary: vuln.summary ?? (vuln.details ? vuln.details.slice(0, 140) : ''),
    severity: extractSeverity(vuln, coordinate.name),
    fixedVersion: extractFixedVersion(vuln, coordinate.name),
  };
}

// --------------------------------------------------------------------------------------------------
// Audit engine
// --------------------------------------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Determine the overall status from findings and errors. */
function statusOf(findings: VulnFinding[], errors: string[], completed: boolean): AuditStatus {
  if (findings.length) return 'vulnerable';
  if (!completed || errors.length) return 'error';
  return 'clean';
}

/** Map an {@link AuditStatus} to a CI-friendly process exit code (clean 0 / vulnerable 1 / error 2). */
export function exitCodeFor(status: AuditStatus): number {
  return status === 'clean' ? 0 : status === 'vulnerable' ? 1 : 2;
}

/**
 * Run the OSV audit for a set of coordinates. Batches querybatch calls, enriches each distinct
 * vulnerability once, and returns a typed, tri-state report. Never throws for network/parse issues
 * — those are recorded in `report.errors` and reflected in `report.status`.
 */
export async function auditCoordinates(coords: Coordinate[], opts: SupplyChainAuditOptions = {}): Promise<SupplyChainReport> {
  const http = opts.http ?? fetchHttpClient;
  const base = (opts.osvBaseUrl ?? DEFAULT_OSV_BASE).replace(/\/$/, '');
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const deduped = dedupe(coords);
  const errors: string[] = [];
  const sources = [...new Set(deduped.map((c) => c.source))].sort() as AuditSource[];

  const baseReport: Omit<SupplyChainReport, 'findings' | 'vulnerablePackages' | 'ok' | 'status'> = {
    generatedAt: new Date().toISOString(),
    sources,
    totalPackages: coords.length,
    scanned: deduped.length,
    errors,
  };

  if (!deduped.length) {
    return { ...baseReport, findings: [], vulnerablePackages: 0, ok: true, status: 'clean' };
  }

  // 1) Batched querybatch — map each coordinate to its vulnerability ids.
  const idsByCoord = new Map<Coordinate, string[]>();
  let batchOk = true;
  for (const group of chunk(deduped, batchSize)) {
    const queries = group.map((c) => (c.version ? { package: { ecosystem: c.ecosystem, name: c.name }, version: c.version } : { package: { ecosystem: c.ecosystem, name: c.name } }));
    try {
      const res = await http(`${base}/v1/querybatch`, { method: 'POST', body: JSON.stringify({ queries }) });
      if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
      const parsed = parseBatchResponse(await res.json(), group.length);
      group.forEach((c, i) => {
        if (parsed[i]!.length) idsByCoord.set(c, parsed[i]!);
      });
    } catch (err) {
      batchOk = false;
      errors.push(`querybatch failed for ${group.length} package(s): ${(err as Error).message}`);
    }
  }

  // 2) Enrich each distinct vulnerability id once (GET /v1/vulns/{id}).
  const uniqueIds = [...new Set([...idsByCoord.values()].flat())];
  const details = new Map<string, OsvVuln>();
  for (const id of uniqueIds) {
    try {
      const res = await http(`${base}/v1/vulns/${encodeURIComponent(id)}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      details.set(id, (await res.json()) as OsvVuln);
    } catch (err) {
      errors.push(`could not fetch details for ${id}: ${(err as Error).message}`);
    }
  }

  // 3) Shape findings.
  const findings: VulnFinding[] = [];
  const vulnerableCoords = new Set<Coordinate>();
  for (const [coord, ids] of idsByCoord) {
    for (const id of ids) {
      vulnerableCoords.add(coord);
      const vuln = details.get(id);
      findings.push(vuln ? toFinding(coord, vuln) : { coordinate: coord, id, aliases: [], summary: '(details unavailable)' });
    }
  }
  findings.sort((a, b) => a.coordinate.name.localeCompare(b.coordinate.name) || a.id.localeCompare(b.id));

  const status = statusOf(findings, errors, batchOk);
  return { ...baseReport, findings, vulnerablePackages: vulnerableCoords.size, ok: batchOk, status };
}
