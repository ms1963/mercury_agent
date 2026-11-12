# Tools

Mercury ships ~75 built-in tools in toolsets (files, shell, web, code, memory, skills,
scheduling, media, messaging, …). Each tool has a risk level: `safe`, `moderate` or
`dangerous`. Dangerous tools require approval unless policy allows them.

- `mercury tools list` / `mercury tools toolsets`
- `mercury tools enable|disable <tool-or-toolset>`
- Web UI → Tools & MCP

**Polyglot tools**: any folder with a `tool.json` manifest in `<repo>/tools`, `~/.mercury/tools`
or `tools.polyglotDirs` becomes a tool. Arguments arrive as JSON on stdin; print plain text or
`{"content": "...", "isError": false}`. Scaffold one with `mercury new tool mytool --lang python`.
