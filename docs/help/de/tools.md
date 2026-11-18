# Tools

Mercury liefert ca. 75 integrierte Tools in Toolsets (files, shell, web, code, memory, skills,
scheduling, media, messaging, …). Jedes Tool hat eine Risikostufe: `safe`, `moderate` oder
`dangerous`. Gefährliche Tools erfordern eine Freigabe, sofern die Richtlinie sie nicht erlaubt.

- `mercury tools list` / `mercury tools toolsets`
- `mercury tools enable|disable <tool-or-toolset>`
- Web-UI → Tools & MCP

**Polyglott-Tools**: Jeder Ordner mit einem `tool.json`-Manifest in `<repo>/tools`, `~/.mercury/tools`
oder `tools.polyglotDirs` wird zu einem Tool. Argumente kommen als JSON über stdin an; geben Sie
reinen Text oder `{"content": "...", "isError": false}` aus. Erstellen Sie eines mit `mercury new tool mytool --lang python`.
