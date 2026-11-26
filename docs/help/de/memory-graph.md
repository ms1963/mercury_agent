# Speichergraph

`mercury memory-graph` projiziert den Speicher, den Mercury **bereits aufzeichnet**, in einen Graphen
aus Entitäten und ihren tatsächlich gespeicherten Beziehungen. Der Befehl ist **nur lesend** und fügt
weder Instrumentierung noch Schema hinzu.

## Knoten

Ein Knoten pro vorhandener Speicher-Entität (Knoten-IDs sind nach Art präfixiert, z. B. `fact:…`,
`run:…`):

- **fact** — semantische Speichereinträge (Tabelle `facts`)
- **skill** — aus erfolgreichen Läufen destillierte Skills (`distilled_skills`)
- **run** — Agenten-Läufe (`runs`)
- **session** — episodische Sitzungen (`sessions`)
- **knowledge** — eingelesene RAG-Quellen, nach Quelle gruppiert (`knowledge`)

## Kanten (belegt — nichts wird erfunden)

Jede Kante ist durch eine real gespeicherte Spalte belegt und wird nur gezeichnet, wenn **beide**
Endpunkte in der Ansicht existieren (ein Verweis auf eine Zeile außerhalb des Bereichs wird verworfen,
nie erfunden):

| Kante | Belegt durch |
|-------|--------------|
| `skill --distilled_from--> run` | `distilled_skills.source_runs[]` |
| `run --in_session--> session` | `runs.session_id` |
| `run --spawned--> run` (Eltern → Kind) | `runs.parent_run_id` |
| `fact --sourced_from--> run\|session` | `facts.source`, **nur wenn** exakt eine bekannte Run-/Session-ID |

Reflexions-/`learn`-Datensätze erscheinen in `mercury journey`, nicht hier: ihre `skill`-Spalte ist ein
freier Name (keine gespeicherte ID), eine Graphkante daraus wäre geraten.

## Verwendung

```
mercury memory-graph [--since <Dauer|ISO>] [--until <Dauer|ISO>] [--limit <n>] [--top <n>] [--dot] [--json]
```

- `--since <d>` / `--until <d>` — auf ein Zeitfenster einschränken; eine Dauer (`30d`, `12h`, `2w`) oder
  ein ISO-Datum.
- `--limit <n>` — höchstens N Zeilen pro Quelltabelle lesen (neueste zuerst).
- `--top <n>` — Anzahl der am stärksten verbundenen Knoten in der Zusammenfassung (Standard 10).
- `--dot` — Graphviz-DOT ausgeben; rendern mit `mercury memory-graph --dot | dot -Tsvg -o memory.svg`.
- `--json` — den vollständigen Graphen `{ nodes, edges, summary }` ausgeben.

Ein leerer Speicher gibt `memory graph is empty` aus und endet mit 0.
