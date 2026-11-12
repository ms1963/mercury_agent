# Workflows

Multi-agent workflows are YAML files naming a template `type` and the agents involved.

Templates: `single`, `pipeline`, `round-robin`, `coordinator-worker`, `tree`, `map-reduce`,
`router`, `blackboard`, `debate`.

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
