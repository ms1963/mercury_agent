# Activity logs

`mercury logs` shows recent Mercury activity from what is **already persisted** — the `runs` table, which
records one row per chat/run. It is read-only and introduces no new log store.

## Usage

```
mercury logs [--limit <n>] [--since <dur|ISO>] [--until <dur|ISO>] [--json]
```

- `mercury logs` — the 20 most recent runs as a table.
- `mercury logs --limit 50` — the 50 most recent runs.
- `mercury logs --since 24h` — activity in the last 24 hours.
- `mercury logs --since 2026-01-01 --until 2026-02-01` — activity in January.
- `mercury logs --json` — the rows as JSON.

## Flags

- `--limit <n>` — show at most `n` rows, most-recent first (default `20`).
- `--since <dur|ISO>` — only activity at/after this instant: a duration (`30d`, `12h`, `90m`, `2w`) or an
  ISO date/datetime.
- `--until <dur|ISO>` — only activity before this instant (same formats).
- `--json` — emit the rows as JSON instead of a table.

## Output

Each row shows the start time, kind (`chat`, `run`, ...), status, and a one-line summary of the input (or
output). An empty result prints `no activity recorded` and exits `0`.

## Notes

- This is a point-in-time view. There is no live `--follow` tail, because runs are persisted after they
  finish rather than streamed to a log file.
