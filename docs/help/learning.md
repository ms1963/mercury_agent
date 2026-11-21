# Learning from runs

Mercury can learn from its own completed runs. The learning subsystem is **off by default**
(`learning.enabled: false`) and every part degrades gracefully when there isn't enough data.

It does three things:

- **Experience hints** — at the start of a run it looks for a similar past *successful* run and
  injects a short hint into the agent's context. No similar run means no hint (nothing is forced).
- **Auto-tuned routing** — it records success rates per (difficulty bucket, model) and feeds them
  back to the model router. The router only prefers a learned model once there are enough samples
  (`routing.minSamples`) above `routing.minSuccessRate`; otherwise it falls back to economics. A
  learning-adjusted decision is flagged `adjustedByLearning`.
- **Failure playbooks** — recurring error signatures and the remediation that later worked are
  persisted, so known failures can be avoided.

## CLI

- `mercury learn stats [bucket]` — observed routing success rates (add `--json`).
- `mercury learn hints <task...>` — preview the hint that would be injected for a task.
- `mercury learn playbooks` — recorded failure playbooks and their remediations.

## Config

```yaml
learning:
  enabled: false            # master switch
  hints:    { enabled: true, maxExamples: 1, minSimilarity: 0.15, lookback: 50 }
  routing:  { enabled: true, minSamples: 5, minSuccessRate: 0.5 }
  playbooks:{ enabled: true, minOccurrences: 2, minSimilarity: 0.2 }
```

The Web UI **Learning** panel (admin) shows the current status, the auto-tuned routing table and
the failure playbooks.
