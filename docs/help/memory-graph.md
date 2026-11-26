# Memory graph

`mercury memory-graph` projects the memory Mercury **already records** into a graph of entities and
their real stored relationships. It is **read-only** and adds no instrumentation or schema.

## Nodes

One node per existing memory entity (node ids are prefixed by kind, e.g. `fact:…`, `run:…`):

- **fact** — semantic memory items (`facts` table)
- **skill** — skills distilled from winning runs (`distilled_skills`)
- **run** — agent runs (`runs`)
- **session** — episodic sessions (`sessions`)
- **knowledge** — ingested RAG sources, grouped by source (`knowledge`)

## Edges (grounded — nothing is invented)

Every edge is backed by a real stored column, and is only drawn when **both** endpoints exist in the
view (a reference to a row outside the current range is dropped, never fabricated):

| Edge | Backed by |
|------|-----------|
| `skill --distilled_from--> run` | `distilled_skills.source_runs[]` |
| `run --in_session--> session` | `runs.session_id` |
| `run --spawned--> run` (parent → child) | `runs.parent_run_id` |
| `fact --sourced_from--> run\|session` | `facts.source`, **only when** it exactly equals a known run/session id |

Reflection / `learn` records appear in `mercury journey`, not here: their `skill` column is a free-text
name (not a stored id), so turning it into a graph edge would be guesswork.

## Usage

```
mercury memory-graph [--since <dur|ISO>] [--until <dur|ISO>] [--limit <n>] [--top <n>] [--dot] [--json]
```

- `--since <d>` / `--until <d>` — restrict to entities created in a window; a duration (`30d`, `12h`,
  `2w`) or an ISO date.
- `--limit <n>` — read at most N rows per source table (most-recent first).
- `--top <n>` — how many most-connected nodes to list in the summary (default 10).
- `--dot` — emit Graphviz DOT; render with `mercury memory-graph --dot | dot -Tsvg -o memory.svg`.
- `--json` — emit the full graph `{ nodes, edges, summary }`.

An empty memory prints `memory graph is empty` and exits 0.
