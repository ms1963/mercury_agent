/**
 * Unified Add-In system.
 *
 * An Add-In is a self-contained, declarative package a user drops into
 * `<dataDir>/addins/<name>/` to add TOOLS, PERSONALITIES and permission PROFILES
 * WITHOUT touching any product source under `packages/`. It unifies the three
 * pre-existing drop-in mechanisms (markdown personalities, polyglot `tool.json`
 * tool folders, and permission profiles) behind one manifest.
 *
 * Layout:
 *   <dataDir>/addins/<name>/
 *     addin.yaml | addin.json     ← manifest (below)
 *     personalities/*.md          ← persona prompt files (same format as dataDir/personalities)
 *     tools/<tool>/tool.json      ← polyglot tool folders (same format as dataDir/tools)
 *
 * Manifest (addin.yaml):
 *   name: my-pack
 *   version: 0.1.0
 *   description: What this add-in provides.
 *   enabled: true
 *   personalities: [personalities/pirate.md]      # files relative to the add-in dir
 *   tools: [tools/greet]                           # dirs (each holds a tool.json), relative
 *   permissions:                                   # name → permission profile (UserPolicy shape)
 *     pirate: { deniedToolsets: [shell], maxToolRisk: safe }
 *
 * This module is PURE filesystem + parsing: no LLM, no network. Malformed add-ins
 * are SKIPPED with a warning and never crash the runtime. It is purely additive —
 * the legacy `dataDir/personalities`, `dataDir/tools` and `dataDir/plugins` scans
 * keep working exactly as before.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Personality } from '../agent/personalities.js';
import type { UserPolicy } from '../auth/policy.js';

const PolicySchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    deniedTools: z.array(z.string()).optional(),
    deniedToolsets: z.array(z.string()).optional(),
    allowedModels: z.array(z.string()).optional(),
    deniedModels: z.array(z.string()).optional(),
    allowedWorkflows: z.array(z.string()).optional(),
    maxToolRisk: z.enum(['safe', 'moderate', 'dangerous']).optional(),
  })
  .strict();

export const AddinManifestSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    version: z.string().default('0.0.0'),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    personalities: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    permissions: z.record(z.string(), PolicySchema).default({}),
  })
  .strip();
export type AddinManifest = z.infer<typeof AddinManifestSchema>;

export interface LoadedAddin {
  name: string;
  dir: string;
  version: string;
  description: string;
  enabled: boolean;
  personalities: Personality[];
  /** Absolute dirs that each contain a polyglot `tool.json` (feed to registerPolyglotTools). */
  toolDirs: string[];
  permissions: Record<string, UserPolicy>;
}

export interface AddinLoadResult {
  addins: LoadedAddin[];
  /** Aggregated personalities contributed by all ENABLED add-ins. */
  personalities: Personality[];
  /** Aggregated polyglot tool dirs contributed by all ENABLED add-ins. */
  toolDirs: string[];
  /** Aggregated permission profiles (name → policy) from all ENABLED add-ins. */
  permissions: Record<string, UserPolicy>;
  /** Human-readable warnings for skipped/invalid add-ins (never thrown). */
  warnings: string[];
}

function parseManifestFile(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
}

/** Parse a personality markdown file (same convention as the Personalities loader). */
function readPersonality(file: string): Personality {
  const text = readFileSync(file, 'utf8').trim();
  const title = (/^#\s*(.+)$/m.exec(text)?.[1] ?? basename(file, '.md')).trim();
  return { name: basename(file, '.md'), title, prompt: text.replace(/^#.*\n?/, '').trim() };
}

/** Load a single add-in directory. Returns null (with a warning pushed) when invalid. */
export function loadAddin(dir: string, warnings: string[]): LoadedAddin | null {
  const manifestFile = ['addin.yaml', 'addin.yml', 'addin.json'].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!manifestFile) {
    warnings.push(`addin "${basename(dir)}": no addin.yaml/addin.json manifest — skipped`);
    return null;
  }
  let manifest: AddinManifest;
  try {
    manifest = AddinManifestSchema.parse(parseManifestFile(manifestFile));
  } catch (err) {
    warnings.push(`addin "${basename(dir)}": invalid manifest (${manifestFile}): ${String(err)} — skipped`);
    return null;
  }

  const personalities: Personality[] = [];
  for (const rel of manifest.personalities) {
    const file = resolve(dir, rel);
    if (!file.startsWith(resolve(dir))) {
      warnings.push(`addin "${manifest.name}": personality path "${rel}" escapes the add-in dir — skipped`);
      continue;
    }
    if (!existsSync(file)) {
      warnings.push(`addin "${manifest.name}": personality file "${rel}" not found — skipped`);
      continue;
    }
    try {
      personalities.push(readPersonality(file));
    } catch (err) {
      warnings.push(`addin "${manifest.name}": cannot read personality "${rel}": ${String(err)} — skipped`);
    }
  }

  const toolDirs: string[] = [];
  for (const rel of manifest.tools) {
    const tdir = resolve(dir, rel);
    if (!tdir.startsWith(resolve(dir))) {
      warnings.push(`addin "${manifest.name}": tool path "${rel}" escapes the add-in dir — skipped`);
      continue;
    }
    if (!existsSync(join(tdir, 'tool.json'))) {
      warnings.push(`addin "${manifest.name}": tool dir "${rel}" has no tool.json — skipped`);
      continue;
    }
    toolDirs.push(tdir);
  }

  return {
    name: manifest.name,
    dir,
    version: manifest.version,
    description: manifest.description,
    enabled: manifest.enabled,
    personalities,
    toolDirs,
    permissions: manifest.permissions as Record<string, UserPolicy>,
  };
}

/**
 * Discover and load every add-in under the given base dirs. Aggregates the
 * contributions of ENABLED add-ins. Always returns a result (never throws);
 * problems are collected in `warnings`.
 */
export function loadAddins(dirs: string[]): AddinLoadResult {
  const warnings: string[] = [];
  const addins: LoadedAddin[] = [];
  const seen = new Set<string>();
  for (const base of dirs) {
    if (!existsSync(base)) continue;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch (err) {
      warnings.push(`addins dir "${base}": ${String(err)} — skipped`);
      continue;
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const addin = loadAddin(dir, warnings);
      if (!addin) continue;
      if (seen.has(addin.name)) {
        warnings.push(`addin "${addin.name}": duplicate name (from ${dir}) — later copy skipped`);
        continue;
      }
      seen.add(addin.name);
      addins.push(addin);
    }
  }

  const enabled = addins.filter((a) => a.enabled);
  const permissions: Record<string, UserPolicy> = {};
  for (const a of enabled) for (const [k, v] of Object.entries(a.permissions)) permissions[k] = v;

  return {
    addins,
    personalities: enabled.flatMap((a) => a.personalities),
    toolDirs: enabled.flatMap((a) => a.toolDirs),
    permissions,
    warnings,
  };
}
