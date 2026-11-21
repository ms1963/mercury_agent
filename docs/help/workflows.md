# Workflows

Multi-agent workflows are YAML files naming a template `type` and the agents involved.

Templates: `single`, `pipeline`, `round-robin`, `coordinator-worker`, `tree`, `map-reduce`,
`router`, `blackboard`, `debate`, `planner-executor`.

```yaml
name: research-report
type: pipeline
agents:
  - name: researcher
    role: Find facts.
    task: "Research: {input}"
  - name: writer
    role: Write clearly.
    task: "Write a report from these notes:\n{previous}"
```
Run with `mercury workflow run research-report "topic"` or the web Workflows panel. Budgets
(`maxSubagents`, `maxDepth`, `maxRuns`) bound every run.

## Planner-executor (deeper, multi-step runs)

If workflows finish too quickly, use `planner-executor`: a planner first decomposes the task
into several concrete steps, then an executor runs each step in order (feeding earlier results
forward) and a synthesizer writes the final answer. If a step fails it re-plans once and
continues instead of stopping. Each step emits a `workflow.step` event so progress is observable.

```yaml
name: deep-dive
type: planner-executor
options:
  minSteps: 3      # always run at least this many steps
  targetSteps: 5   # how many steps the planner aims for
  maxSteps: 12     # hard cap (never exceeded)
  replanOnFailure: true
agents:
  - name: planner      # optional; used to produce the step list
    role: Break the goal into clear, ordered steps.
  - name: executor     # runs each step (falls back to the first non-planner agent)
    role: Carry out one step at a time.
  - name: synthesizer  # optional; writes the final combined answer
    role: Combine the step results into a complete answer.
```

Defaults come from `workflows.planner` in config (`enabled` is off by default for the auto
pattern; the template itself is always available by name). `options` on the spec override them.
The `maxSteps` cap and existing run budgets prevent runaway loops.
