# Lauf-Wiedergabe & Zeitreise-Debugging

Mercury speichert von jedem Lauf eine Aufzeichnung des Ereignisstroms, sodass Sie ihn wie eine
Aufnahme wiedergeben und debuggen können. Dies ist **standardmäßig an** (`replay.enabled: true`)
und abwärtskompatibel.

Was Sie tun können:

- **Aufgezeichnete Läufe auflisten** und einen öffnen.
- **Die Zeitachse Schritt für Schritt durchlaufen** und den **rekonstruierten Zustand** bei jedem
  Schritt prüfen — Anzahl der LLM- und Werkzeugaufrufe, aufgelaufene Kosten, Tokens und ob der
  Zustand „tainted“ (verunreinigt) ist.
- **Abzweigen & neu ausführen** — einen Schritt wählen, optional eine **Eingabe bearbeiten** und
  „von hier neu ausführen“. Mercury zweigt einen neuen verknüpften Lauf ab (`parent_run_id` +
  `from_step`), der alles bis zu diesem Schritt wiederverwendet und alles Nachfolgende
  deterministisch neu berechnet. Governance und Freigaben gelten weiterhin für den neu berechneten
  Teil.

## CLI / API

- `GET /api/traces` — aufgezeichnete Läufe auflisten.
- `GET /api/runs/:id/timetravel` — die vollständige Aufzeichnung eines Laufs.
- `GET /api/runs/:id/state?step=N` — rekonstruierter Zustand bei Schritt N.
- `POST /api/runs/:id/replay {fromStep, edits}` — ab einem Schritt mit bearbeiteten Eingaben abzweigen und neu ausführen.

Programmatisch wird dasselbe über die Fassade `mercury.traces` bereitgestellt: `listTraces`,
`getTrace`, `getStateAt`, `replayFrom`.

## Konfiguration

```yaml
replay:
  enabled: true        # Hauptschalter für Aufzeichnung, Fassadenmethoden und Endpunkte
  retainTraces: 1000   # max. Anzahl gespeicherter Lauf-Aufzeichnungen (älteste zuerst entfernt)
  persistDeltas: false # auch rekonstruierte Zustandsdeltas pro Schritt speichern (größere Aufzeichnungen)
```

Das Web-UI-Panel **Lauf-Wiedergabe** (Admin) listet aufgezeichnete Läufe auf, zeigt Zeitachse und
rekonstruierten Zustand und bietet die Steuerung zum Bearbeiten der Eingabe / Neuausführen ab einem Schritt.
