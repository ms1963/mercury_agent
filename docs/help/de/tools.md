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

**Web-Lesen (`web_read`)**: ruft eine Webseite ab und extrahiert ihren Hauptinhalt (entfernt
Navigation, Kopf-/Fußzeile, Formulare). Es hat die Risikostufe `moderate`, ist als sensibel
markiert und läuft hinter der bestehenden Freigabe-/Richtlinien-Engine und dem SSRF-Schutz — es
verweigert private/Loopback-Adressen und alles, was die Richtlinie ablehnt, genau wie andere
sensible Netzwerk-Tools. Seine Ausgabe gilt als nicht vertrauenswürdig.

**Skill-Komposition (`skill_compose`)**: führt einen Skill zusammen mit anderen Skills und Tools
als kleinen zusammengesetzten Plan aus, mit zwischengespeicherten Ergebnissen (TTL) und einem
Rekursionsschutz. Tiefe und Schritt-Budgets stammen aus `composition` in der Konfiguration
(`maxDepth`, `maxSteps`, `cache`). Ein zusammengesetzter Schritt, der auf einen bereits im Stack
befindlichen Skill zurückgreift, wird abgelehnt, sodass Kompositionen nicht endlos laufen können.
