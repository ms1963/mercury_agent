/**
 * External secret stores for Mercury (Tier-2 gap #6).
 *
 * Mercury configs may embed secret *references* — `${SECRET:...}` — that are resolved to real values at
 * **connect time** (e.g. just before an MCP server is launched), so no plaintext secret is ever written
 * into the config file. This mirrors and complements the MCP preset `${ENV_VAR}` pattern
 * ({@link ../../../mcp/src/presets.ts}): `${ENV_VAR}` is substituted once, at preset-enable time, and the
 * concrete value is stored; `${SECRET:...}` is left in the config and resolved live from a pluggable
 * backend every run. The two coexist — this module only ever touches `${SECRET:...}` and leaves bare
 * `${ENV_VAR}` placeholders alone.
 *
 * ## Reference syntax
 *   - `${SECRET:backend:key}` — resolve `key` through the named `backend` (e.g. `${SECRET:op:op://v/i/f}`).
 *   - `${SECRET:key}`         — resolve `key` through the configured **default backend** (default `env`).
 *
 * A CLI-supplied reference (for `mercury secrets get`) may be the bare inner spec (`backend:key` / `key`)
 * or the full `${SECRET:...}` wrapper.
 *
 * ## Backends
 * A {@link SecretBackend} maps a key to a value. Built in:
 *   - {@link envBackend}         — reads from an env map (default `process.env`).
 *   - {@link bitwardenBackend}   — `bw get password <key>` via an INJECTED command runner.
 *   - {@link onepasswordBackend} — `op read <key>` via an INJECTED command runner.
 * External-CLI backends never shell out in tests because the runner is injected; the real runner
 * ({@link defaultSecretRunner}) uses `execFileSync`.
 *
 * ## Safety
 * No function here ever persists or logs a plaintext secret. {@link maskSecret} is the only presentation
 * helper and it never reveals the value; the CLI reveals a value only behind an explicit `--reveal` flag.
 *
 * The module is split into PURE logic (reference parsing, masking, backend wiring over injected runners —
 * fully unit-testable) and a thin default runner that is the only piece that touches the OS.
 */
import { execFileSync } from 'node:child_process';
import { errorMessage } from '../types/common.js';

/** Global matcher for `${SECRET:...}` references embedded in a string. */
export const SECRET_REF_RE = /\$\{SECRET:([^}]+)\}/g;

/** Backend name aliases → canonical backend id. Used to disambiguate `backend:key` from a bare key. */
export const BACKEND_ALIASES: Record<string, string> = {
  env: 'env',
  bw: 'bitwarden',
  bitwarden: 'bitwarden',
  op: 'onepassword',
  '1password': 'onepassword',
  onepassword: 'onepassword',
};

/** A parsed secret reference: an optional explicit backend plus the lookup key. */
export interface SecretRef {
  /** Canonical backend id, or undefined to use the configured default. */
  backend?: string;
  key: string;
}

/**
 * Parse the inner spec of a secret reference (the part inside `${SECRET:...}`, or a bare CLI argument).
 *
 * Splits on the FIRST colon: if the prefix is a known backend alias, it is the backend and the remainder
 * (which may itself contain colons, e.g. `op://vault/item/field`) is the key. Otherwise the whole spec is
 * the key and the default backend is used.
 */
export function parseSecretRef(spec: string): SecretRef {
  const s = (spec ?? '').trim();
  if (!s) throw new Error('empty secret reference');
  const colon = s.indexOf(':');
  if (colon > 0) {
    const prefix = s.slice(0, colon).toLowerCase();
    const canonical = BACKEND_ALIASES[prefix];
    if (canonical) {
      const key = s.slice(colon + 1).trim();
      if (!key) throw new Error(`secret reference "${spec}" is missing a key`);
      return { backend: canonical, key };
    }
  }
  return { key: s };
}

/** Strip a `${SECRET:...}` wrapper if present, returning the inner spec; otherwise the input unchanged. */
export function unwrapSecretRef(ref: string): string {
  const m = /^\$\{SECRET:([^}]+)\}$/.exec((ref ?? '').trim());
  return m ? m[1]!.trim() : (ref ?? '').trim();
}

/** The result of running a backend CLI through the runner. */
export interface SecretRunResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** An injected command runner so external-CLI backends are testable and never shell out in tests. */
export type SecretCommandRunner = (cmd: string, args: string[]) => SecretRunResult;

/** The real runner — runs `cmd args` synchronously, capturing stdout; failures become `{ ok: false }`. */
export const defaultSecretRunner: SecretCommandRunner = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: '', error: errorMessage(err) };
  }
};

/** A pluggable secret backend: resolves a key to a value, and reports whether it is usable. */
export interface SecretBackend {
  /** Canonical backend id (`env`, `bitwarden`, `onepassword`, ...). */
  name: string;
  /** A short human description for `mercury secrets backends`. */
  describe: string;
  /** Whether this backend is usable right now (e.g. its CLI is installed). */
  available(): boolean;
  /** Resolve `key` to a value, or undefined if not found. Throws only on a hard backend error. */
  resolve(key: string): string | undefined;
}

/** Backend that reads from an environment map (defaults to `process.env`). Always available. */
export function envBackend(env: Record<string, string | undefined> = process.env): SecretBackend {
  return {
    name: 'env',
    describe: 'Environment variables (process env)',
    available: () => true,
    resolve: (key) => {
      const v = env[key];
      return v === undefined || v === '' ? undefined : v;
    },
  };
}

/** Options shared by the external-CLI backends. */
export interface CliBackendOptions {
  runner?: SecretCommandRunner;
  /** Override the CLI binary name/path (default `bw` / `op`). */
  command?: string;
}

/** Bitwarden backend: `bw get password <key>` through the injected runner. */
export function bitwardenBackend(opts: CliBackendOptions = {}): SecretBackend {
  const runner = opts.runner ?? defaultSecretRunner;
  const cmd = opts.command ?? 'bw';
  return {
    name: 'bitwarden',
    describe: `Bitwarden CLI (${cmd} get password <key>)`,
    available: () => runner(cmd, ['--version']).ok,
    resolve: (key) => {
      const r = runner(cmd, ['get', 'password', key]);
      if (!r.ok) return undefined;
      const v = r.stdout.trim();
      return v === '' ? undefined : v;
    },
  };
}

/** 1Password backend: `op read <key>` (key is an `op://vault/item/field` secret reference). */
export function onepasswordBackend(opts: CliBackendOptions = {}): SecretBackend {
  const runner = opts.runner ?? defaultSecretRunner;
  const cmd = opts.command ?? 'op';
  return {
    name: 'onepassword',
    describe: `1Password CLI (${cmd} read <op://...>)`,
    available: () => runner(cmd, ['--version']).ok,
    resolve: (key) => {
      const r = runner(cmd, ['read', key]);
      if (!r.ok) return undefined;
      const v = r.stdout.trim();
      return v === '' ? undefined : v;
    },
  };
}

/** The relevant subset of `config.secrets` (structural, so this module does not import the zod schema). */
export interface SecretsConfigLike {
  defaultBackend?: string;
  bitwarden?: { enabled?: boolean; command?: string };
  onepassword?: { enabled?: boolean; command?: string };
}

/** Options for building the backend set / resolver. */
export interface BuildBackendsOptions {
  env?: Record<string, string | undefined>;
  runner?: SecretCommandRunner;
}

/**
 * Build the configured backend set. The `env` backend is always present. Bitwarden / 1Password are added
 * only when enabled in config (so the resolver never implies a backend the operator did not opt into).
 */
export function buildBackends(cfg: SecretsConfigLike = {}, opts: BuildBackendsOptions = {}): Map<string, SecretBackend> {
  const backends = new Map<string, SecretBackend>();
  backends.set('env', envBackend(opts.env));
  if (cfg.bitwarden?.enabled) backends.set('bitwarden', bitwardenBackend({ runner: opts.runner, command: cfg.bitwarden.command }));
  if (cfg.onepassword?.enabled) backends.set('onepassword', onepasswordBackend({ runner: opts.runner, command: cfg.onepassword.command }));
  return backends;
}

/** Mask a secret for display — NEVER reveals the value (fixed-width, no length leak). */
export function maskSecret(value: string): string {
  return value ? '********' : '';
}

/** One `${SECRET:...}` reference encountered while expanding a value. */
export interface ExpandedRef {
  /** The full matched reference text (`${SECRET:...}`) or inner spec when scanned directly. */
  raw: string;
  backend: string;
  key: string;
  resolved: boolean;
  error?: string;
}

/** The result of expanding secrets within a value/object. */
export interface ExpandResult<T> {
  value: T;
  refs: ExpandedRef[];
}

/**
 * Resolves `${SECRET:...}` references against a set of backends. Pure except for whatever the injected
 * backends do; never logs or persists values.
 */
export class SecretResolver {
  constructor(private backends: Map<string, SecretBackend>, public readonly defaultBackend: string = 'env') {}

  /** The backend ids this resolver knows about. */
  backendNames(): string[] {
    return [...this.backends.keys()];
  }

  /** Look up a backend by name/alias (or the default when `name` is omitted). Throws if unknown. */
  backendFor(name?: string): SecretBackend {
    const target = name ?? this.defaultBackend;
    const canonical = BACKEND_ALIASES[target.toLowerCase()] ?? target;
    const b = this.backends.get(canonical);
    if (!b) throw new Error(`unknown secret backend "${target}" (known: ${this.backendNames().join(', ') || 'none'})`);
    return b;
  }

  /** Resolve a single reference spec to its value. Throws if the backend is unknown/unavailable or the key is missing. */
  resolveRef(spec: string): { ref: Required<SecretRef>; value: string } {
    const parsed = parseSecretRef(spec);
    const backend = this.backendFor(parsed.backend);
    if (!backend.available()) throw new Error(`secret backend "${backend.name}" is not available`);
    const value = backend.resolve(parsed.key);
    if (value === undefined || value === '') throw new Error(`secret not found: ${parsed.key} (backend: ${backend.name})`);
    return { ref: { backend: backend.name, key: parsed.key }, value };
  }

  /**
   * Expand every `${SECRET:...}` reference in a string. Resolved references are replaced by their value;
   * an unresolved reference is LEFT in place (so the failure is visible, exactly like the MCP env
   * substitution) and recorded in the returned `refs` with its error.
   */
  expand(value: string): ExpandResult<string> {
    const refs: ExpandedRef[] = [];
    const out = value.replace(SECRET_REF_RE, (raw, inner: string) => {
      try {
        const { ref, value: v } = this.resolveRef(inner);
        refs.push({ raw, backend: ref.backend, key: ref.key, resolved: true });
        return v;
      } catch (err) {
        const parsed = parseSecretRef(inner);
        refs.push({ raw, backend: parsed.backend ?? this.defaultBackend, key: parsed.key, resolved: false, error: errorMessage(err) });
        return raw;
      }
    });
    return { value: out, refs };
  }
}

/**
 * Recursively expand `${SECRET:...}` references in any value (string / array / plain object). Non-string
 * leaves pass through unchanged. Returns a NEW structure plus the aggregate list of references seen.
 */
export function expandSecretsDeep<T>(obj: T, resolver: SecretResolver): ExpandResult<T> {
  const refs: ExpandedRef[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = resolver.expand(v);
      refs.push(...r.refs);
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return { value: walk(obj) as T, refs };
}

/** Collect the inner specs of every `${SECRET:...}` reference in a value/object (deduplicated, in order). */
export function scanSecretRefs(obj: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(SECRET_REF_RE)) {
        const inner = m[1]!.trim();
        if (!seen.has(inner)) {
          seen.add(inner);
          out.push(inner);
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(obj);
  return out;
}

/** Build a {@link SecretResolver} from a `config.secrets`-shaped object. Tolerates a missing/partial config. */
export function secretResolverFromConfig(cfg: SecretsConfigLike = {}, opts: BuildBackendsOptions = {}): SecretResolver {
  const backends = buildBackends(cfg, opts);
  return new SecretResolver(backends, cfg.defaultBackend ?? 'env');
}
