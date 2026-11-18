# Workflows

Multi-Agenten-Workflows sind YAML-Dateien, die einen Vorlagentyp (`type`) und die beteiligten Agenten benennen.

Vorlagen: `single`, `pipeline`, `round-robin`, `coordinator-worker`, `tree`, `map-reduce`,
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
Führen Sie ihn mit `mercury workflow run research-report "topic"` oder dem Web-Panel „Workflows" aus. Budgets
(`maxSubagents`, `maxDepth`, `maxRuns`) begrenzen jeden Lauf.
