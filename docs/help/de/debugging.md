# Beobachtbarkeit & Fehlersuche

Jeder Lauf zeichnet eine Ereignisspur auf (LLM-Aufrufe, Tool-Aufrufe, Entscheidungen, Guardrails, Subagenten).

- Web → Runs: Spuren und Subagenten-Bäume untersuchen; Web → Observability: Live-Ereignisse, pausierte Läufe, Audit-Log.
- Haltepunkte: vor Tool-Aufrufen / LLM-Aufrufen pausieren (`/debug` oder das Observability-Panel), dann fortsetzen oder abbrechen.
- `mercury replay <runId>` gibt eine Spur aus; `/metrics` stellt Prometheus-Metriken bereit.
