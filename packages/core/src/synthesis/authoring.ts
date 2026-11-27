/**
 * Authoring step for self-extending tools.
 *
 * Builds the prompt sent to the (injected) LLM runner to draft a tool, and parses + structurally
 * validates the model's JSON response into a {@link SynthesizedToolDraft}. Pure: the LLM runner is
 * injected, so authoring is unit-testable with a stub that returns canned JSON.
 */
import { z } from 'zod';
import { emptyManifest, type CapabilityManifest, type SynthesizedToolDraft, type SynthRuntime } from './types.js';

/** What the agent is asking for — the gap that motivated synthesis. */
export interface AuthoringRequest {
  /** The missing capability (human description or the requested tool name). */
  capability: string;
  /** The triggering task/prompt context. */
  context: string;
  /** Runtimes the policy allows (the model must pick one of these). */
  allowedRuntimes: SynthRuntime[];
  /** Capabilities the policy is willing to grant (so the model doesn't over-ask). */
  grantable: { filesystem: boolean; network: boolean; hosts: string[]; shell: boolean };
}

/**
 * Build the authoring prompt. It instructs the model to return ONLY a JSON object with the tool's
 * name, description, parameters (JSON schema), runtime, code, test and a least-privilege capability
 * manifest. The polyglot protocol (read JSON args on stdin, write a JSON/text result to stdout) is
 * spelled out so the generated code is runnable behind the existing out-of-process boundary.
 */
export function buildAuthoringPrompt(req: AuthoringRequest): string {
  const grant = req.grantable;
  return [
    'You are generating a NEW tool for an AI agent because a needed capability is missing.',
    `Missing capability: ${req.capability}`,
    `Triggering context: ${req.context.slice(0, 1000)}`,
    '',
    'Return ONLY a single JSON object (no markdown, no prose) with these fields:',
    '  name        : snake_case slug, [a-z][a-z0-9_]{2,63}',
    '  description : one sentence describing exactly what the tool does',
    '  parameters  : a JSON Schema object ({ "type":"object", "properties":{...}, "required":[...] })',
    `  runtime     : one of ${JSON.stringify(req.allowedRuntimes)}`,
    '  code        : the implementation. It MUST define a function run(args) that takes the parsed',
    '                arguments object and returns the result (a dict/object, or a string), AND include',
    '                a main guard that reads a JSON object of arguments from STDIN and writes the',
    '                result to STDOUT as JSON {"content": "...", "isError": false}.',
    '                  - python: `def run(args): ...` plus `if __name__ == "__main__":` reading',
    '                    sys.stdin and printing json.dumps({"content": str(run(args)), "isError": False}).',
    '                  - node  : `export function run(args) { ... }` plus a main guard (detect',
    '                    import.meta.url === main) reading process.stdin and writing the JSON result.',
    '  test        : a SELF-CONTAINED unit test that IMPORTS run from the implementation and asserts',
    '                its behaviour, exiting NON-ZERO on failure. python: `from main import run` (the',
    '                impl is saved as main.py). node: `import { run } from "./main.mjs"` (saved as',
    '                main.mjs). Do not spawn subprocesses or use a test framework; use plain asserts.',
    '  capabilities: a least-privilege manifest { filesystem:boolean, network:"none"|"allow",',
    '                hosts:string[], shell:boolean }. Request the MINIMUM you need; anything you do',
    '                not declare is denied at runtime.',
    '',
    'Hard limits on what will be granted (do NOT request more or the tool is rejected):',
    `  filesystem allowed: ${grant.filesystem}`,
    `  network allowed   : ${grant.network}${grant.network ? ` (only these hosts: ${grant.hosts.join(', ') || '(none configured)'})` : ''}`,
    `  shell allowed     : ${grant.shell}`,
    '',
    'Prefer a pure, dependency-free implementation. Never read secrets or environment variables for',
    'credentials — the sandbox passes none. Output the JSON object now.',
  ].join('\n');
}

const RuntimeSchema = z.enum(['python', 'node']);

const ManifestSchema = z.object({
  filesystem: z.boolean().default(false),
  network: z.enum(['none', 'allow']).default('none'),
  hosts: z.array(z.string()).default([]),
  shell: z.boolean().default(false),
});

const DraftSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  runtime: RuntimeSchema,
  code: z.string(),
  test: z.string(),
  capabilities: ManifestSchema.default(emptyManifest()),
});

/** Parse result: either a validated draft or a list of structural errors. */
export type ParseResult = { ok: true; draft: SynthesizedToolDraft } | { ok: false; errors: string[] };

/**
 * Extract a JSON object from the model's raw output (tolerating ```json fences / leading prose) and
 * validate it into a {@link SynthesizedToolDraft}. Returns structural errors rather than throwing.
 */
export function parseDraft(raw: string): ParseResult {
  const json = extractJsonObject(raw);
  if (json === undefined) return { ok: false, errors: ['no JSON object found in author output'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [`author output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = DraftSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const d = result.data;
  const manifest: CapabilityManifest = {
    filesystem: d.capabilities.filesystem,
    network: d.capabilities.network,
    hosts: d.capabilities.hosts,
    shell: d.capabilities.shell,
  };
  return {
    ok: true,
    draft: {
      name: d.name.trim(),
      description: d.description.trim(),
      parameters: d.parameters,
      runtime: d.runtime,
      code: d.code,
      test: d.test,
      capabilities: manifest,
    },
  };
}

/** Pull the first balanced top-level `{...}` JSON object out of arbitrary text. */
export function extractJsonObject(raw: string): string | undefined {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
