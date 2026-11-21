# Evaluation-driven self-improvement

Mercury can measure itself and improve itself — safely. You promote real runs into labeled **eval
cases**, group them into a **suite**, replay the suite for a single blended **score**, and let a
**governed auto-tuner** propose changes, test each one against the suite, and keep only the changes
that actually improve the score. The harness is **on by default** but safe (it only reads and
scores); the auto-tuner is **off by default** because it mutates configuration.

## Eval cases and suites

An eval case is a reproducible test promoted from a real (or 👍-rated) run: its original input plus
the **expected outcome** — tools that should fire, substrings the output must contain, a reference
output used for a similarity metric, and an optional per-task cost ceiling. Cases are grouped into a
suite scoped to an agent/model.

- **Promote a run** → a case: the run's input and what it did become the expected outcome.
- **Replay a suite** → an `EvalScoreRecord`: pass-rate, cost-per-task, intervention-rate and
  output-similarity, combined (by configurable weights) into one 0..1 score and persisted as a time
  series so the scorecard can chart the trend per agent.

## Governed auto-tune

The tuner proposes changes — model routing, agent pattern, temperature, distilled-skill
promote/retire, prompt tweaks — then for each proposal:

1. **Governance first.** A proposal that would touch a protected area (security, governance,
   approvals, policies) is rejected outright.
2. **Measure.** The proposal is applied to a throwaway copy and the suite is re-scored.
3. **Budget.** A candidate whose cost-per-task exceeds the configured ceiling is rejected.
4. **Keep only improvements.** The change is accepted only if the score improves by at least
   `minImprovement`. A regressing or neutral proposal is rejected.

Accepted tunes are **versioned and reversible** — each records the previous values of the keys it
changed, so any tune can be reverted. With `autotune.autoApply: false` (the default) accepted
proposals still require an explicit apply.

## CLI / API

- `GET /api/evals` — status, config and suites.
- `GET /api/evals/suites/:id` — a suite with its cases and score trend.
- `POST /api/evals/suites` — create a suite.
- `POST /api/evals/cases` / `DELETE /api/evals/cases/:id` — manage cases.
- `POST /api/evals/promote {runId, suiteId}` — promote a run into a case.
- `POST /api/evals/suites/:id/run` — replay and score the suite.
- `GET /api/evals/suites/:id/trend` — the score time series.
- `POST /api/evals/suites/:id/tune` — propose, test and evaluate tunes.
- `POST /api/evals/suites/:id/apply-tune` — apply an accepted tune evaluation.
- `GET /api/evals/tunes` / `POST /api/evals/tunes/:id/revert` — list and revert versioned tunes.

Programmatically the same is exposed via the `mercury.evals` facade: `createSuite`, `addCase`,
`promoteRun`, `runSuite`, `trend`, `proposeTune`, `applyTune`, `listTunes`, `revertTune`.

## Config

```yaml
evals:
  enabled: true          # harness master switch (safe: read/score only)
  retainScores: 500      # max suite scores kept per suite (oldest pruned first)
  weights:               # combined into one 0..1 score (normalized internally)
    passRate: 0.5
    cost: 0.2
    intervention: 0.15
    similarity: 0.15
  costCeiling: 0.05      # $ treated as the worst acceptable cost-per-task
  autotune:
    enabled: false       # OFF by default — the tuner mutates config
    minImprovement: 0.02 # minimum score gain a proposal must deliver to be kept
    maxProposals: 8      # runaway guard
    autoApply: false     # apply accepted proposals automatically (needs approval when false)
```

The Web UI **Evaluations & Auto-tune** panel (admin) lists suites and cases, promotes runs, runs a
suite, charts the scorecard trend, and drives the propose/apply/revert tune workflow.
