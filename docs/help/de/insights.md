# Nutzungsauswertungen

`mercury insights` verwandelt die Token-/Kostenabrechnung, die Mercury **bereits aufzeichnet**, in eine
berichtsfähige Analyseansicht. Der Befehl ist nur lesend und fügt keine neue Instrumentierung oder kein
neues Schema hinzu — er aggregiert ausschließlich vorhandene Zeilen.

## Was aggregiert wird

Der Bericht wird aus dem **Nutzungs-Ledger** (`usage`-Tabelle) erstellt, das Mercury bei jedem
Modellaufruf schreibt (siehe `BudgetService.record`). Jede Ledger-Zeile enthält: Zeitstempel, Modell,
Eingabe-/Ausgabe-Tokens, Kosten, Art (`chat`, `decision`, …), die id des handelnden Benutzers sowie die
id des auslösenden Laufs. Die Zeilen werden mit der `runs`-Tabelle verknüpft, sodass eine Zeile ihrer
**Sitzung** zugeordnet werden kann.

Aus diesen Zeilen berechnet der Befehl:

- **Summen** — Gesamtaufrufe, Eingabe-/Ausgabe-/Gesamt-Tokens und Gesamtkosten über den gewählten
  Zeitraum.
- **Aufschlüsselungen** — dieselben Kennzahlen gruppiert nach Tag, Modell, Agent (Benutzer) oder Sitzung.
- **Top-N** — die teuersten Buckets bei einer Gruppierung ungleich Tag.
- **Zeitraum** — der früheste und späteste abgedeckte Nutzungszeitstempel.

## Verwendung

```
mercury insights [--by day|model|agent|session] [--since <dauer|ISO>] [--until <dauer|ISO>]
                 [--top <n>] [--limit <n>] [--json]
```

- `mercury insights` — Tagesübersicht über alle aufgezeichnete Nutzung (Standardgruppierung `--by day`).
- `mercury insights --by model --top 5` — die fünf teuersten Modelle.
- `mercury insights --by agent --since 30d` — Nutzung pro Benutzer der letzten 30 Tage.
- `mercury insights --by session --since 2026-01-01 --until 2026-02-01` — Nutzung pro Sitzung im Januar.
- `mercury insights --json` — der vollständige Bericht (`totals`, `by`, `buckets`, `firstTs`, `lastTs`,
  `empty`).

## Optionen

- `--by <dim>` — Aufschlüsselungsdimension: `day` (Standard), `model`, `agent` (der handelnde Benutzer)
  oder `session`.
- `--since <dauer|ISO>` — nur Nutzung ab diesem Zeitpunkt. Akzeptiert eine relative Dauer (`30d`, `12h`,
  `90m`, `2w`, `45s`) oder ein ISO-Datum/-Zeit (`2026-01-01`, `2026-01-01T12:00:00Z`).
- `--until <dauer|ISO>` — nur Nutzung **vor** diesem Zeitpunkt (gleiche Formate).
- `--top <n>` — nur die `n` teuersten Buckets behalten (gilt für `model`/`agent`/`session`; Tages-Buckets
  bleiben chronologisch).
- `--limit <n>` — höchstens `n` Ledger-Zeilen (neueste zuerst) vor der Aggregation lesen.
- `--json` — den Bericht als JSON statt als Tabelle ausgeben.

## Ausgabe

Die Standardansicht gibt eine Summenzeile plus eine Tabelle der Buckets (Schlüssel, Aufrufe, Tokens,
Kosten) aus. Token-Zahlen werden zur besseren Lesbarkeit abgekürzt (`1,234`, `15.0k`, `2.4M`), Kosten in
USD mit einer Genauigkeit, die sich an kleine Beträge anpasst.

Ein **leeres Ledger** (keine Nutzung aufgezeichnet oder keine im gewählten Zeitraum) gibt
`no usage recorded` aus und beendet sich mit `0`. Ein Exit-Code ungleich null tritt nur bei echten Fehlern
auf (z. B. ein ungültiger `--by`-Wert oder ein nicht parsebares `--since`/`--until`).

## Hinweise

- Die `agent`-Gruppierung schlüsselt nach der `user_id` des Ledgers; Zeilen ohne diese werden als
  `(unattributed)` gebündelt.
- Die `session`-Gruppierung beruht auf der Verknüpfung `run_id → runs.session_id`; Zeilen, deren Lauf
  keine Sitzung (oder keine Lauf-id) hat, werden als `(no session)` gebündelt.
- Dieser Befehl ändert nicht, wie Nutzung aufgezeichnet wird — siehe `mercury budgets` für die
  Live-Budget-/Limit-Seite desselben Ledgers.
