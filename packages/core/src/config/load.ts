/**
 * Layered configuration loader: defaults < config file < environment < CLI flags.
 * Also provides `.env` loading, dotted-path get/set and config migration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ConfigSchema, type MercuryConfig } from './schema.js';

export const CONFIG_VERSION = 1;

/** Root of the user's Mercury home (config, data, extensions). */
export function mercuryHome(): string {
  return resolve(process.env.MERCURY_HOME ?? join(homedir(), '.mercury'));
}

/**
 * Directory holding bundled assets (locales, docs/help, skills, tools, workflows, personalities).
 * Found by walking up from this module until a folder containing `locales/en.json` exists.
 */
export function assetsDir(): string {
  if (process.env.MERCURY_ASSETS) return resolve(process.env.MERCURY_ASSETS);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'locales', 'en.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Minimal `.env` parser: KEY=VALUE lines, quotes stripped, never overrides existing env. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  }
  return out;
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

export function setPath(obj: Obj, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Parse a CLI/env string into boolean/number/JSON when it looks like one. */
export function coerceValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      /* keep string */
    }
  }
  return raw;
}

/** Well-known env vars plus generic `MERCURY__section__key=value` overrides. */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): Obj {
  const out: Obj = {};
  const map: Record<string, string> = {
    MERCURY_PORT: 'server.port',
    MERCURY_HOST: 'server.host',
    MERCURY_MODEL: 'llm.defaultModel',
    MERCURY_LOG_LEVEL: 'logLevel',
    MERCURY_LOCALE: 'locale',
    MERCURY_DATA_DIR: 'dataDir',
    MERCURY_DEBUG: 'debug',
    MERCURY_APPROVALS: 'tools.approvals.mode',
    MERCURY_DECISION_PROVIDER: 'decision.provider',
  };
  for (const [envKey, path] of Object.entries(map)) {
    const v = env[envKey];
    if (v !== undefined && v !== '') setPath(out, path, coerceValue(v));
  }
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('MERCURY__') && v !== undefined) {
      setPath(out, k.slice(9).split('__').join('.'), coerceValue(v));
    }
  }
  return out;
}

export interface LoadConfigOptions {
  /** Explicit config file path (else MERCURY_CONFIG, ./mercury.yaml, ~/.mercury/config.yaml). */
  file?: string;
  /** Highest-priority overrides (CLI flags). */
  overrides?: Obj;
  /** Skip reading files and env (tests). */
  isolated?: boolean;
}

export function findConfigFile(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.MERCURY_CONFIG, join(process.cwd(), 'mercury.yaml'), join(mercuryHome(), 'config.yaml')];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

export function readConfigFile(file: string): Obj {
  const text = readFileSync(file, 'utf8');
  const parsed = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  return migrateConfig(isObj(parsed) ? parsed : {});
}

/** Upgrade older config shapes. Version 0 used `model` at top level. */
export function migrateConfig(raw: Obj): Obj {
  const cfg = { ...raw };
  const version = typeof cfg.version === 'number' ? cfg.version : 0;
  if (version < 1 && typeof cfg.model === 'string') {
    setPath(cfg, 'llm.defaultModel', cfg.model);
    delete cfg.model;
  }
  delete cfg.version;
  return cfg;
}

export interface LoadedConfig {
  config: MercuryConfig;
  file?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  let merged: Obj = {};
  let file: string | undefined;
  if (!opts.isolated) {
    loadDotEnv(join(process.cwd(), '.env'));
    loadDotEnv(join(mercuryHome(), '.env'));
    file = findConfigFile(opts.file);
    if (file) merged = deepMerge(merged, readConfigFile(file));
    merged = deepMerge(merged, envOverrides());
  }
  if (opts.overrides) merged = deepMerge(merged, opts.overrides);
  const config = ConfigSchema.parse(merged);
  if (!config.dataDir) config.dataDir = mercuryHome();
  config.dataDir = resolve(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true });
  return { config, file };
}

/** Persist a single dotted key into the user config file (creating it if needed). */
export function setConfigValue(path: string, value: unknown, file = join(mercuryHome(), 'config.yaml')): string {
  const raw = existsSync(file) ? readConfigFile(file) : {};
  setPath(raw, path, value);
  // Validate before writing so a typo never corrupts the config.
  ConfigSchema.parse(raw);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, YAML.stringify({ version: CONFIG_VERSION, ...raw }));
  return file;
}
