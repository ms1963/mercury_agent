# Lernen aus Läufen

Mercury kann aus seinen eigenen abgeschlossenen Läufen lernen. Das Lern-Subsystem ist
**standardmäßig aus** (`learning.enabled: false`) und jeder Teil greift bei zu wenig Daten elegant
auf Fallbacks zurück.

Es leistet drei Dinge:

- **Erfahrungshinweise** — zu Beginn eines Laufs sucht es nach einem ähnlichen früheren
  *erfolgreichen* Lauf und fügt einen kurzen Hinweis in den Kontext des Agenten ein. Gibt es keinen
  ähnlichen Lauf, gibt es keinen Hinweis (nichts wird erzwungen).
- **Automatisch abgestimmtes Routing** — es zeichnet Erfolgsquoten pro (Schwierigkeitsklasse,
  Modell) auf und führt sie an den Modell-Router zurück. Der Router bevorzugt ein gelerntes Modell
  erst, wenn genügend Stichproben (`routing.minSamples`) über `routing.minSuccessRate` vorliegen;
  andernfalls greift er auf die Ökonomie zurück. Eine durch Lernen angepasste Entscheidung wird mit
  `adjustedByLearning` gekennzeichnet.
- **Fehler-Playbooks** — wiederkehrende Fehlersignaturen und die später erfolgreiche Behebung werden
  gespeichert, sodass bekannte Fehler vermieden werden können.

## CLI

- `mercury learn stats [bucket]` — beobachtete Routing-Erfolgsquoten (mit `--json`).
- `mercury learn hints <task...>` — Vorschau des Hinweises, der für eine Aufgabe eingefügt würde.
- `mercury learn playbooks` — aufgezeichnete Fehler-Playbooks und ihre Behebungen.

## Konfiguration

```yaml
learning:
  enabled: false            # Hauptschalter
  hints:    { enabled: true, maxExamples: 1, minSimilarity: 0.15, lookback: 50 }
  routing:  { enabled: true, minSamples: 5, minSuccessRate: 0.5 }
  playbooks:{ enabled: true, minOccurrences: 2, minSimilarity: 0.2 }
```

Das Web-UI-Panel **Lernen** (Admin) zeigt den aktuellen Status, die Tabelle des automatisch
abgestimmten Routings und die Fehler-Playbooks.
