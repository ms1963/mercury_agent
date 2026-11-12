# Extending Mercury

Mercury loads extensions from the repository (bundled) and from `$MERCURY_HOME` (default `~/.mercury`).
Scaffold any of them with `mercury new <tool|skill|workflow|adapter|plugin> <name>`.

| Extension | Location | Format |
|---|---|---|
| Polyglot tool | `tools/<name>/`, `$MERCURY_HOME/tools/<name>/`, `tools.polyglotDirs` | `tool.json` + any executable |
| Skill | `skills/<name>/`, `$MERCURY_HOME/skills/<name>/`, `skills.dirs` | `SKILL.md` (agentskills.io frontmatter) |
| Workflow | `workflows/*.yaml`, `$MERCURY_HOME/workflows/*.yaml` | YAML naming a template `type` |
| Personality | `personalities/*.md` | Markdown system-prompt overlay |
| Plugin | `$MERCURY_HOME/plugins/<name>.mjs` or `<name>/index.js`, `plugins: [...]` in config | ES module exporting a `Plugin` |
| Gateway adapter | via plugin `registerAdapter()` | class implementing `Adapter` |
| MCP server tools | `mcp.servers` in config / `mercury mcp` | any MCP server (stdio / HTTP) |

## Polyglot tools (any language)

A tool is a folder with a `tool.json` manifest. Mercury writes the JSON arguments to the process's
**stdin** and returns its **stdout** as the tool result (a non-zero exit code is reported as an error).

```json
{
  "name": "slugify",
  "description": "Turn a title into a URL-friendly slug.",
  "toolset": "polyglot",
  "risk": "safe",
  "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "command": ["node", "main.mjs"],
  "requires": ["node"]
}
```

- `risk`: `safe` runs freely; riskier levels go through approval gating (see [SECURITY.md](SECURITY.md)).
- `requires`: binaries that must exist on `PATH`; the tool is hidden when they are missing.
- Examples: `tools/word_count_py` (Python), `tools/slugify_js` (JavaScript), `tools/hash_go` (Go).

## Skills

```markdown
---
name: code-review
description: Review a code change for bugs and security issues. Use when the user asks for a review.
metadata: { version: 1, tags: [code, quality] }
---
# Code review
1. Read the files — do not guess.
...
```

The `description` is shown to the model so it can decide when to load the skill. Skills are also
exposed as MCP prompts and `skill://` resources. Install with `mercury skills install <path|git-url>`.

## Workflows

```yaml
name: debate
description: Two agents argue, a judge decides.
type: debate            # single | pipeline | round-robin | coordinator-worker | tree |
                        # map-reduce | router | blackboard | debate
agents:
  - { name: proponent, role: Argue FOR the proposition. }
  - { name: opponent,  role: Argue AGAINST the proposition. }
  - { name: judge,     role: Weigh both sides and give a verdict. }
options: { rounds: 2 }
budget: { maxRuns: 8 }
```

Run with `mercury workflow run debate "Remote work is better"`, from the web UI, or via the
`run_workflow` MCP tool. `auto` lets the decision engine pick a workflow.

## Plugins

```js
// ~/.mercury/plugins/hello.mjs
export default {
  name: 'hello',
  version: '1.0.0',
  setup(api) {
    api.registerTool({
      name: 'hello',
      description: 'Say hello',
      toolset: 'custom',
      risk: 'safe',
      parameters: { type: 'object', properties: { who: { type: 'string' } } },
      async execute(args) { return `Hello, ${args.who ?? 'world'}!`; },
    });
    // Hooks receive a payload and may return a patch object (or nothing).
    api.registerHook('before_tool_call', (payload) => { api.logger.info('tool', { tool: payload.tool }); });
  },
};
```

`PluginAPI` (see `packages/core/src/plugins/plugin.ts`) offers `registerTool`, `registerHook`,
`registerMemoryProvider`, `registerContextEngine`, `registerLLMProvider`, `registerDecisionProvider`,
`registerPattern`, `registerWorkflowTemplate` and `registerAdapter`. `mercury plugins` lists loaded
plugins and load errors. Use `mercury new plugin <name>` for an exact, up-to-date skeleton.

## Gateway adapters

Implement `Adapter` from `@mercury/gateway` (or extend `BaseAdapter`):

```ts
interface Adapter {
  readonly name: string;
  readonly type: string;
  readonly textOnly?: boolean;
  start(sink: InboundSink): Promise<void>;     // begin polling / connect; push InboundMessage to sink
  stop(): Promise<void>;
  send(out: OutboundMessage): Promise<void>;
  status(): AdapterStatus;
  handleWebhook?(req: WebhookRequest): Promise<WebhookResponse>; // mounted at /webhooks/<name>
}
```

Use the injected `deps.transport` for HTTP so adapters can be tested with `MockTransport`
(see `tests/integrations.test.ts`). Register the factory from a plugin with
`api.registerAdapter('myplatform', (config) => new MyAdapter(...))`, then add it under
`gateway.adapters` in the config.

## LLM and decision providers

An `LLMProvider` implements `chat()` / streaming for a `provider/model` id; a `DecisionProvider`
answers typed questions (`choice`, `boolean`, `score` …) with confidences. Register both from a plugin.
The built-in Jev provider (`packages/core/src/decision/jev.ts`) is a compact reference.
