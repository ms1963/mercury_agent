# Usage insights

`mercury insights` turns the token/cost accounting Mercury **already records** into a reportable
analytics view. It is read-only and adds no new instrumentation or schema — it only aggregates existing
rows.

## What it aggregates

The report is built from the **usage ledger** (`usage` table), which Mercury writes on every model call
(see `BudgetService.record`). Each ledger row has: timestamp, model, input/output tokens, cost, kind
(`chat`, `decision`, …), the acting user id, and the originating run id. Rows are joined to the `runs`
table so a row can be attributed to its **session**.

From these rows the command computes:

- **Totals** — total calls, input/output/total tokens, and total cost over the selected range.
- **Breakdowns** — the same metrics grouped by day, model, agent (user) or session.
- **Top-N** — the costliest buckets for a non-day grouping.
- **Time range** — the earliest and latest usage timestamps covered.

## Usage

```
mercury insights [--by day|model|agent|session] [--since <dur|ISO>] [--until <dur|ISO>]
                 [--top <n>] [--limit <n>] [--json]
```

- `mercury insights` — daily summary over all recorded usage (default grouping is `--by day`).
- `mercury insights --by model --top 5` — the five costliest models.
- `mercury insights --by agent --since 30d` — per-user usage over the last 30 days.
- `mercury insights --by session --since 2026-01-01 --until 2026-02-01` — per-session usage for January.
- `mercury insights --json` — the full report (`totals`, `by`, `buckets`, `firstTs`, `lastTs`, `empty`).

## Flags

- `--by <dim>` — breakdown dimension: `day` (default), `model`, `agent` (the acting user), or `session`.
- `--since <dur|ISO>` — keep only usage at/after this instant. Accepts a relative duration (`30d`, `12h`,
  `90m`, `2w`, `45s`) or an ISO date/datetime (`2026-01-01`, `2026-01-01T12:00:00Z`).
- `--until <dur|ISO>` — keep only usage **before** this instant (same formats).
- `--top <n>` — keep only the `n` costliest buckets (applies to `model`/`agent`/`session` groupings; day
  buckets stay chronological).
- `--limit <n>` — read at most `n` ledger rows (most-recent first) before aggregating.
- `--json` — emit the report as JSON instead of a table.

## Output

The default view prints a totals line plus a table of buckets (key, calls, tokens, cost). Token counts
are abbreviated for readability (`1,234`, `15.0k`, `2.4M`) and costs are shown in USD with precision that
scales to small amounts.

An **empty ledger** (no usage recorded, or none in the selected range) prints `no usage recorded` and
exits `0`. A non-zero exit happens only on real errors (e.g. an invalid `--by` value or an unparseable
`--since`/`--until`).

## Notes

- `agent` grouping keys on the ledger's `user_id`; rows without one are bucketed as `(unattributed)`.
- `session` grouping relies on the `run_id → runs.session_id` join; rows whose run has no session (or no
  run id) are bucketed as `(no session)`.
- This command does not change how usage is recorded — see `mercury budgets` for the live budget/limit
  side of the same ledger.
