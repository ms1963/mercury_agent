/**
 * `mercury new tool|skill|workflow|adapter|plugin <name>` scaffolding.
 * Generated extensions are plain files (JSON/YAML/Markdown/ESM JavaScript) that
 * Mercury picks up without a build step; watched directories hot-reload them.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MercuryError } from '../types/common.js';
import { slugify } from '../skills/parser.js';

export type ExtensionKind = 'tool' | 'skill' | 'workflow' | 'adapter' | 'plugin';
export const EXTENSION_KINDS: ExtensionKind[] = ['tool', 'skill', 'workflow', 'adapter', 'plugin'];

export interface ScaffoldOptions {
  /** Language for polyglot tools: python | js | cpp | java | go. */
  language?: string;
}

type Files = Record<string, string>;

function toolFiles(name: string, language = 'python'): Files {
  const id = name.replace(/-/g, '_');
  const manifest = (command: string[], build?: string[]) =>
    JSON.stringify(
      {
        name: id,
        description: `TODO: describe what ${id} does (shown to the LLM).`,
        toolset: 'custom',
        risk: 'safe',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: ['text'] },
        command,
        ...(build ? { build } : {}),
        timeoutMs: 15000,
      },
      null,
      2,
    );
  // Protocol: arguments arrive as JSON on stdin; print {"content": "..."} (or plain text) on stdout.
  switch (language) {
    case 'js':
      return {
        'tool.json': manifest(['node', 'main.mjs']),
        'main.mjs': `// Reads JSON args from stdin, writes a JSON result to stdout.\nlet input = '';\nprocess.stdin.on('data', (c) => (input += c));\nprocess.stdin.on('end', () => {\n  const args = JSON.parse(input || '{}');\n  process.stdout.write(JSON.stringify({ content: \`echo: \${args.text ?? ''}\` }));\n});\n`,
      };
    case 'cpp':
      return {
        'tool.json': manifest(['./main'], ['g++', '-O2', '-o', 'main', 'main.cpp']),
        'main.cpp': `// Reads JSON args from stdin and echoes them back inside a result object.\n#include <iostream>\n#include <iterator>\n#include <string>\nint main() {\n  std::string in((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());\n  std::cout << "{\\"content\\": \\"received " << in.size() << " bytes\\"}";\n}\n`,
      };
    case 'java':
      return {
        'tool.json': manifest(['java', 'Main.java']),
        'Main.java': `// Single-file Java tool (Java 11+ runs .java sources directly).\npublic class Main {\n  public static void main(String[] a) throws Exception {\n    String in = new String(System.in.readAllBytes());\n    System.out.print("{\\"content\\": \\"received " + in.length() + " bytes\\"}");\n  }\n}\n`,
      };
    case 'go':
      return {
        'tool.json': manifest(['go', 'run', 'main.go']),
        'main.go': `// Go tool: reads JSON args on stdin, prints a JSON result.\npackage main\n\nimport (\n\t"encoding/json"\n\t"os"\n)\n\nfunc main() {\n\tvar args map[string]any\n\t_ = json.NewDecoder(os.Stdin).Decode(&args)\n\t_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"content": args["text"]})\n}\n`,
      };
    default:
      return {
        'tool.json': manifest(['python3', 'main.py']),
        'main.py': `"""Reads JSON args from stdin, writes a JSON result to stdout."""\nimport json, sys\n\nargs = json.load(sys.stdin)\nprint(json.dumps({"content": f"echo: {args.get('text', '')}"}))\n`,
      };
  }
}

const skillFiles = (name: string): Files => ({
  'SKILL.md': `---\nname: ${name}\ndescription: TODO one sentence telling the agent when to use this skill.\ntags: [custom]\n---\n\n# ${name}\n\n## When to use\nDescribe the situations where this skill applies.\n\n## Procedure\n1. First step.\n2. Second step.\n\n## Pitfalls\n- Things to avoid.\n`,
});

const workflowFiles = (name: string): Files => ({
  [`${name}.yaml`]: `# Workflow template. Types: single, pipeline, round-robin, coordinator-worker, tree,\n# map-reduce, router, blackboard, debate. Run with: mercury workflow run ${name} "<input>"\nname: ${name}\ndescription: TODO describe the workflow\ntype: pipeline\nbudget:\n  maxRuns: 6\nagents:\n  - name: researcher\n    role: Collect the relevant facts.\n    task: "Research: {input}"\n  - name: writer\n    role: Write the final answer.\n    task: "Using these notes, answer the request.\\n\\n{previous}"\n`,
});

const adapterFiles = (name: string): Files => ({
  'index.mjs': `/**\n * Gateway adapter plugin "${name}". Register it under gateway.adapters.${name} in config.\n * An adapter turns platform messages into InboundMessage objects (sink) and sends replies.\n */\nexport default {\n  name: '${name}-adapter',\n  setup(api) {\n    api.registerAdapter('${name}', (config) => {\n      let sink;\n      let connected = false;\n      return {\n        name: '${name}',\n        type: '${name}',\n        textOnly: true,\n        async start(s) { sink = s; connected = true; /* TODO connect to the platform */ },\n        async stop() { connected = false; },\n        async send(out) { api.logger.info('${name} send', { chatId: out.chatId, text: out.text }); },\n        status() { return { connected, detail: config.detail ?? '' }; },\n        // Call this from your transport when a message arrives:\n        receive(text, userId, chatId) { return sink?.({ platform: '${name}', userId, chatId: chatId ?? userId, text }); },\n      };\n    });\n  },\n};\n`,
});

const pluginFiles = (name: string): Files => ({
  'index.mjs': `/**\n * Mercury plugin "${name}". Plugins can register tools, hooks, memory providers,\n * LLM/decision providers, patterns, workflow templates and gateway adapters.\n */\nexport default {\n  name: '${name}',\n  version: '0.1.0',\n  description: 'TODO describe the plugin',\n  setup(api) {\n    api.registerTool({\n      name: '${name.replace(/-/g, '_')}_hello',\n      description: 'Says hello (example tool from the ${name} plugin).',\n      toolset: 'custom',\n      risk: 'safe',\n      parameters: { type: 'object', properties: { who: { type: 'string' } } },\n      async execute(args) { return \`Hello, \${args.who ?? 'world'}!\`; },\n    });\n    api.registerHook('run_end', async (payload) => { api.logger.debug('${name}: run finished', { runId: payload.runId }); });\n  },\n};\n`,
});

/** Create the extension under `baseDir` and return the created directory/file path. */
export function scaffold(kind: ExtensionKind, rawName: string, baseDir: string, opts: ScaffoldOptions = {}): { path: string; files: string[] } {
  const name = slugify(rawName);
  if (!name) throw new MercuryError('Please provide a name, e.g. `mercury new tool my-tool`', 'bad_name', 'extending');
  const subdir = { tool: 'tools', skill: 'skills', workflow: 'workflows', adapter: 'plugins', plugin: 'plugins' }[kind];
  const files: Files =
    kind === 'tool' ? toolFiles(name, opts.language)
    : kind === 'skill' ? skillFiles(name)
    : kind === 'workflow' ? workflowFiles(name)
    : kind === 'adapter' ? adapterFiles(name)
    : pluginFiles(name);
  const dir = kind === 'workflow' ? join(baseDir, subdir) : join(baseDir, subdir, name);
  if (kind !== 'workflow' && existsSync(dir)) throw new MercuryError(`${dir} already exists`, 'exists', 'extending');
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const full = join(dir, file);
    if (existsSync(full)) throw new MercuryError(`${full} already exists`, 'exists', 'extending');
    writeFileSync(full, content);
    written.push(full);
  }
  return { path: kind === 'workflow' ? written[0]! : dir, files: written };
}
