# Journey timeline

`mercury journey` is a chronological, **newest-first** timeline of the agent's significant events,
built entirely from data Mercury **already records**. It is **read-only** and adds no instrumentation.

## Event kinds

| Glyph | Kind | Source |
|-------|------|--------|
| `M` | memory | a fact was formed (`facts`) |
| `S` | skill | a skill was distilled (`distilled_skills`) |
| `K` | knowledge | a source was ingested (`knowledge`) |
| `R` | run | an agent run started (`runs`) |
| `L` | learn | a post-run reflection / learn outcome (`reflections`) |
| `·` | session | an episodic session started (`sessions`) |

## Usage

```
mercury journey [--since <dur|ISO>] [--until <dur|ISO>] [--limit <n>] [--kind <k1,k2>] [--json]
```

- `--since <d>` / `--until <d>` — restrict to a window; a duration (`30d`, `12h`, `2w`) or an ISO date
  (the upper bound is exclusive).
- `--limit <n>` — show at most N (most-recent) events. The reported `total` and `counts` reflect the
  full range before the limit is applied.
- `--kind <k1,k2>` — comma-separated kinds to include: `memory`, `skill`, `knowledge`, `run`, `learn`,
  `session`.
- `--json` — emit the full timeline `{ events, counts, total, firstTs, lastTs, empty }`.

An empty history prints `no journey events recorded` and exits 0.
