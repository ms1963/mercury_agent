#!/usr/bin/env node
/**
 * Generate docs/TOOLS.md from the built-in tool definitions in
 * packages/tools/src/builtin/*.ts. Keeps the documented tool list in lockstep
 * with the source: run `node scripts/gen-tools-doc.mjs` after adding or
 * renaming a built-in tool. The parser reads the `name`, `description` and
 * `toolset` fields of each `defineTool({...})` block.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtinDir = join(root, 'packages', 'tools', 'src', 'builtin');

// One human-readable heading per toolset key.
const TOOLSET_TITLES = {
  files: 'Files',
  terminal: 'Terminal & processes',
  web: 'Web',
  browser: 'Browser automation',
  code: 'Code & sandbox',
  utility: 'Utility',
  data: 'Data',
  memory: 'Memory',
  agents: 'Agents & workflows',
  media: 'Media',
  decisions: 'Decisions & reasoning',
  git: 'Git',
  messaging: 'Messaging',
  process: 'Processes',
  schedule: 'Scheduler',
  skills: 'Skills',
  system: 'System',
  vector: 'Vector search',
  wiki: 'Wiki',
};

const tools = [];
for (const file of readdirSync(builtinDir).filter((f) => f.endsWith('.ts')).sort()) {
  const src = readFileSync(join(builtinDir, file), 'utf8');
  // Match each defineTool block's leading fields. name/description/toolset are
  // emitted close together in every definition.
  const re = /defineTool[\s\S]*?name:\s*'([^']+)'[\s\S]*?description:\s*'((?:[^'\\]|\\.)*)'[\s\S]*?toolset:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    tools.push({ name: m[1], description: m[2].replace(/\\'/g, "'"), toolset: m[3], file });
  }
}

tools.sort((a, b) => (a.toolset === b.toolset ? a.name.localeCompare(b.name) : a.toolset.localeCompare(b.toolset)));

const byToolset = new Map();
for (const t of tools) {
  if (!byToolset.has(t.toolset)) byToolset.set(t.toolset, []);
  byToolset.get(t.toolset).push(t);
}

const order = [...byToolset.keys()].sort((a, b) => (TOOLSET_TITLES[a] ?? a).localeCompare(TOOLSET_TITLES[b] ?? b));

const lines = [];
lines.push('# Built-in Tools');
lines.push('');
lines.push('<!-- GENERATED FILE — do not edit by hand.');
lines.push('     Regenerate with: node scripts/gen-tools-doc.mjs -->');
lines.push('');
lines.push(`Mercury ships **${tools.length} built-in tools**, registered automatically at startup`);
lines.push('(`registerBuiltinTools()` in `packages/tools/src/index.ts`). These are compiled');
lines.push('TypeScript, not files on disk — the `tools/` directory at the repository root holds');
lines.push('only *example* external tools (Go / JS / Python) that show how to add your own.');
lines.push('');
lines.push('The agent is given the tools allowed by the active toolsets and policy; see');
lines.push('[docs/EXTENDING.md](EXTENDING.md) to add your own, and [docs/SECURITY.md](SECURITY.md)');
lines.push('for approvals, the path jail and the SSRF guard that govern tool use.');
lines.push('');
lines.push('## Summary');
lines.push('');
lines.push('| Toolset | Count |');
lines.push('| --- | ---: |');
for (const ts of order) lines.push(`| ${TOOLSET_TITLES[ts] ?? ts} | ${byToolset.get(ts).length} |`);
lines.push(`| **Total** | **${tools.length}** |`);
lines.push('');

for (const ts of order) {
  lines.push(`## ${TOOLSET_TITLES[ts] ?? ts}`);
  lines.push('');
  lines.push('| Tool | Description |');
  lines.push('| --- | --- |');
  for (const t of byToolset.get(ts)) {
    const desc = t.description.replace(/\|/g, '\\|');
    lines.push(`| \`${t.name}\` | ${desc} |`);
  }
  lines.push('');
}

writeFileSync(join(root, 'docs', 'TOOLS.md'), lines.join('\n') + '\n');
console.log(`Wrote docs/TOOLS.md with ${tools.length} tools across ${order.length} toolsets.`);
