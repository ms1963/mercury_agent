/**
 * `mercury addin scaffold <name>` — writes a ready-to-copy Add-In template into the
 * DATA DIR (never the product source). The generated add-in has a manifest, a sample
 * personality, a sample polyglot tool, and a sample permission profile, so a user can
 * add tools/personalities/permissions without touching anything under packages/.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MercuryError } from '../types/common.js';

export interface AddinScaffoldResult {
  path: string;
  files: string[];
}

/** Create `<baseDir>/<name>/` with a sample manifest, personality, tool and permission profile. */
export function scaffoldAddin(name: string, baseDir: string): AddinScaffoldResult {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new MercuryError(`invalid add-in name "${name}"`, 'bad_request', 'config', 400);
  const id = name.replace(/-/g, '_');
  const root = join(baseDir, name);
  if (existsSync(root)) throw new MercuryError(`add-in "${name}" already exists at ${root}`, 'conflict', 'config', 409);

  const files: Record<string, string> = {
    'addin.yaml':
      `# Mercury Add-In manifest. Drop this folder in <dataDir>/addins/ — no build, no source edits.\n` +
      `name: ${name}\n` +
      `version: 0.1.0\n` +
      `description: Sample add-in (personality + polyglot tool + permission profile).\n` +
      `enabled: true\n\n` +
      `# Markdown persona files, relative to this add-in dir:\n` +
      `personalities:\n  - personalities/${id}.md\n\n` +
      `# Polyglot tool folders (each holds a tool.json), relative to this add-in dir:\n` +
      `tools:\n  - tools/${id}_echo\n\n` +
      `# Per-personality/agent permission profiles (UserPolicy shape). A profile can only\n` +
      `# further RESTRICT the acting user, never escalate. See docs/PERMISSIONS.md.\n` +
      `permissions:\n  ${id}:\n    deniedToolsets: [shell]\n    maxToolRisk: safe\n`,
    [`personalities/${id}.md`]:
      `# ${name}\n\nYou are ${name}, a focused assistant contributed by the "${name}" add-in. ` +
      `Be concise and helpful, and stay within your permitted tools.\n`,
    [`tools/${id}_echo/tool.json`]: JSON.stringify(
      {
        name: `${id}_echo`,
        description: `Echo back the given text (sample tool from the ${name} add-in).`,
        toolset: 'custom',
        risk: 'safe',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
        command: ['python3', 'main.py'],
        timeoutMs: 15000,
      },
      null,
      2,
    ) + '\n',
    [`tools/${id}_echo/main.py`]:
      `"""Sample polyglot tool: reads JSON args on stdin, writes a JSON result on stdout."""\n` +
      `import json, sys\n\nargs = json.load(sys.stdin)\nprint(json.dumps({"content": f"echo: {args.get('text', '')}"}))\n`,
  };

  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    written.push(rel);
  }
  return { path: root, files: written };
}
