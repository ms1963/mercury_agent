# Run replay & time-travel debugging

Mercury persists a trace of every run's event stream so you can replay it and debug it like a
recording. This is **on by default** (`replay.enabled: true`) and backward-compatible.

What you can do:

- **List traced runs** and open one.
- **Scrub the timeline** step by step and inspect the **reconstructed state** at each step —
  LLM-call and tool-call counts, accumulated cost, tokens, and whether the state is tainted.
- **Fork & re-run** — pick a step, optionally **edit an input**, and "re-run from here". Mercury
  forks a new linked run (`parent_run_id` + `from_step`) that reuses everything up to that step and
  deterministically recomputes everything downstream. Governance and approvals still apply to the
  recomputed portion.

## CLI / API

- `GET /api/traces` — list traced runs.
- `GET /api/runs/:id/timetravel` — the full trace for a run.
- `GET /api/runs/:id/state?step=N` — reconstructed state at step N.
- `POST /api/runs/:id/replay {fromStep, edits}` — fork and re-run from a step with edited inputs.

Programmatically the same is exposed via the `mercury.traces` facade: `listTraces`, `getTrace`,
`getStateAt`, `replayFrom`.

## Config

```yaml
replay:
  enabled: true        # master switch for tracing, facade methods and endpoints
  retainTraces: 1000   # max per-run traces to keep (oldest pruned first)
  persistDeltas: false # also persist reconstructed per-step state deltas (larger traces)
```

The Web UI **Run Replay** panel (admin) lists traced runs, shows the timeline and reconstructed
state, and offers the edit-input / re-run-from-step fork controls.
