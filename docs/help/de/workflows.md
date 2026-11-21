# Workflows

Multi-Agenten-Workflows sind YAML-Dateien, die einen Vorlagentyp (`type`) und die beteiligten Agenten benennen.

Vorlagen: `single`, `pipeline`, `round-robin`, `coordinator-worker`, `tree`, `map-reduce`,
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
Führen Sie ihn mit `mercury workflow run research-report "topic"` oder dem Web-Panel „Workflows" aus. Budgets
(`maxSubagents`, `maxDepth`, `maxRuns`) begrenzen jeden Lauf.

## Planner-Executor (tiefere, mehrstufige Läufe)

Wenn Workflows zu schnell enden, verwenden Sie `planner-executor`: Ein Planer zerlegt die Aufgabe
zunächst in mehrere konkrete Schritte, dann führt ein Executor jeden Schritt der Reihe nach aus
(frühere Ergebnisse werden weitergereicht) und ein Synthesizer schreibt die endgültige Antwort.
Schlägt ein Schritt fehl, wird einmal neu geplant und fortgefahren, statt zu stoppen. Jeder Schritt
sendet ein `workflow.step`-Ereignis, sodass der Fortschritt beobachtbar ist.

```yaml
name: deep-dive
type: planner-executor
options:
  minSteps: 3      # mindestens so viele Schritte ausführen
  targetSteps: 5   # Zielanzahl der Schritte des Planers
  maxSteps: 12     # harte Obergrenze (wird nie überschritten)
  replanOnFailure: true
agents:
  - name: planner      # optional; erzeugt die Schrittliste
    role: Zerlege das Ziel in klare, geordnete Schritte.
  - name: executor     # führt jeden Schritt aus (fällt auf den ersten Nicht-Planer-Agenten zurück)
    role: Führe jeweils einen Schritt aus.
  - name: synthesizer  # optional; schreibt die endgültige kombinierte Antwort
    role: Fasse die Schrittergebnisse zu einer vollständigen Antwort zusammen.
```

Die Standardwerte stammen aus `workflows.planner` in der Konfiguration (`enabled` ist für das
Auto-Muster standardmäßig aus; die Vorlage selbst ist stets über ihren Namen verfügbar). `options`
in der Spezifikation überschreiben sie. Die Obergrenze `maxSteps` und die bestehenden Lauf-Budgets
verhindern Endlosschleifen.
