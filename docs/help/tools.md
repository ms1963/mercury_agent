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

**Web read (`web_read`)**: fetches a web page and extracts its main text content (strips nav,
header, footer, forms). It is risk `moderate`, marked sensitive, and runs behind the existing
approval/policy engine and the SSRF guard — it refuses private/loopback addresses and anything
policy denies, exactly like other sensitive network tools. Its output is treated as untrusted.
By default it uses plain HTTP; pass `render=true` (or set `tools.web.render: true`) to render the
page in a headless browser first — useful for JavaScript-heavy pages — after which the same
extraction runs on the live DOM. When no browser backend is installed it falls back to HTTP.

**Skill composition (`skill_compose`)**: runs a skill together with other skills and tools as a
small composed plan, with results cached (TTL) and a recursion guard. Depth and step budgets come
from `composition` in config (`maxDepth`, `maxSteps`, `cache`). A composed step that cycles back
to a skill already on the stack is rejected, so compositions cannot loop forever.
