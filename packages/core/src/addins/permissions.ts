/**
 * Declarative per-agent / per-personality permission profiles.
 *
 * A profile maps a personality/agent NAME to a policy (same shape as UserPolicy).
 * Profiles come from two additive sources, merged (later wins on name clash):
 *   1. `<dataDir>/permissions/<name>.yaml` — one profile per file (file name = profile name),
 *      OR a single file containing a `{ <name>: <policy>, ... }` map.
 *   2. Add-in manifests (see loader.ts) contributing a `permissions:` section.
 *
 * Pure filesystem + parsing; invalid files are skipped with a warning, never thrown.
 * The resolved map is handed to PolicyEngine's `profileOf`, so a running agent's
 * personality can only FURTHER RESTRICT the acting user (see effectivePolicy).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
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

export interface PermissionProfilesResult {
  profiles: Record<string, UserPolicy>;
  warnings: string[];
}

/** Try to parse a value as either a single policy or a `{name: policy}` map. */
function coerce(file: string, raw: unknown, out: Record<string, UserPolicy>, warnings: string[]): void {
  const single = PolicySchema.safeParse(raw);
  if (single.success) {
    out[basename(file).replace(/\.(ya?ml|json)$/i, '')] = single.data as UserPolicy;
    return;
  }
  const asMap = z.record(z.string(), PolicySchema).safeParse(raw);
  if (asMap.success) {
    for (const [k, v] of Object.entries(asMap.data)) out[k] = v as UserPolicy;
    return;
  }
  warnings.push(`permission profile "${file}": not a valid policy or name→policy map — skipped`);
}

/** Load permission profiles from `<dir>/*.yaml|*.yml|*.json` files. */
export function loadPermissionProfiles(dirs: string[]): PermissionProfilesResult {
  const profiles: Record<string, UserPolicy> = {};
  const warnings: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      warnings.push(`permissions dir "${dir}": ${String(err)} — skipped`);
      continue;
    }
    for (const f of entries.filter((x) => /\.(ya?ml|json)$/i.test(x))) {
      const file = join(dir, f);
      try {
        if (!statSync(file).isFile()) continue;
        const raw = f.endsWith('.json') ? JSON.parse(readFileSync(file, 'utf8')) : parseYaml(readFileSync(file, 'utf8'));
        coerce(file, raw, profiles, warnings);
      } catch (err) {
        warnings.push(`permission profile "${file}": ${String(err)} — skipped`);
      }
    }
  }
  return { profiles, warnings };
}
