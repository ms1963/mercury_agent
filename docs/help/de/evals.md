# Evaluierungsgesteuerte Selbstverbesserung

Mercury kann sich selbst messen und sich selbst verbessern — auf sichere Weise. Sie befördern echte
Läufe zu beschrifteten **Testfällen**, gruppieren sie in einer **Suite**, spielen die Suite für
einen einzigen gemischten **Wert** erneut ab und lassen einen **regelkonformen Auto-Tuner**
Änderungen vorschlagen, jede davon gegen die Suite testen und nur die Änderungen behalten, die den
Wert tatsächlich verbessern. Das Harness ist **standardmäßig an**, aber sicher (es liest und bewertet
nur); der Auto-Tuner ist **standardmäßig aus**, weil er die Konfiguration verändert.

## Testfälle und Suiten

Ein Testfall ist ein reproduzierbarer Test, der aus einem echten (oder mit 👍 bewerteten) Lauf
befördert wurde: seine ursprüngliche Eingabe plus das **erwartete Ergebnis** — Werkzeuge, die
auslösen sollen, Teilzeichenketten, die die Ausgabe enthalten muss, eine Referenzausgabe für ein
Ähnlichkeitsmaß und eine optionale Kostenobergrenze pro Aufgabe. Fälle werden in einer Suite
gruppiert, die einem Agenten/Modell zugeordnet ist.

- **Einen Lauf befördern** → einen Fall: Die Eingabe des Laufs und was er getan hat, werden zum
  erwarteten Ergebnis.
- **Eine Suite erneut abspielen** → einen `EvalScoreRecord`: Erfolgsquote, Kosten pro Aufgabe,
  Eingriffsquote und Ausgabe-Ähnlichkeit, mit konfigurierbaren Gewichten zu einem Wert von 0..1
  kombiniert und als Zeitreihe gespeichert, sodass die Scorecard den Verlauf pro Agent darstellen
  kann.

## Regelkonformes Auto-Tuning

Der Tuner schlägt Änderungen vor — Modell-Routing, Agentenmuster, Temperatur, Beförderung/Rückzug
destillierter Skills, Prompt-Anpassungen — und dann für jeden Vorschlag:

1. **Governance zuerst.** Ein Vorschlag, der einen geschützten Bereich berühren würde (Sicherheit,
   Governance, Freigaben, Richtlinien), wird sofort abgelehnt.
2. **Messen.** Der Vorschlag wird auf eine Wegwerfkopie angewendet und die Suite neu bewertet.
3. **Budget.** Ein Kandidat, dessen Kosten pro Aufgabe die konfigurierte Obergrenze überschreiten,
   wird abgelehnt.
4. **Nur Verbesserungen behalten.** Die Änderung wird nur übernommen, wenn sich der Wert um
   mindestens `minImprovement` verbessert. Ein verschlechternder oder neutraler Vorschlag wird
   abgelehnt.

Übernommene Anpassungen sind **versioniert und rückgängig machbar** — jede speichert die vorherigen
Werte der geänderten Schlüssel, sodass jede Anpassung rückgängig gemacht werden kann. Mit
`autotune.autoApply: false` (dem Standard) erfordern übernommene Vorschläge weiterhin eine
ausdrückliche Anwendung.

## CLI / API

- `GET /api/evals` — Status, Konfiguration und Suiten.
- `GET /api/evals/suites/:id` — eine Suite mit ihren Fällen und ihrem Wertverlauf.
- `POST /api/evals/suites` — eine Suite erstellen.
- `POST /api/evals/cases` / `DELETE /api/evals/cases/:id` — Fälle verwalten.
- `POST /api/evals/promote {runId, suiteId}` — einen Lauf zu einem Fall befördern.
- `POST /api/evals/suites/:id/run` — die Suite erneut abspielen und bewerten.
- `GET /api/evals/suites/:id/trend` — die Wert-Zeitreihe.
- `POST /api/evals/suites/:id/tune` — Anpassungen vorschlagen, testen und auswerten.
- `POST /api/evals/suites/:id/apply-tune` — eine übernommene Anpassungsauswertung anwenden.
- `GET /api/evals/tunes` / `POST /api/evals/tunes/:id/revert` — versionierte Anpassungen auflisten
  und rückgängig machen.

Programmatisch wird dasselbe über die Fassade `mercury.evals` bereitgestellt: `createSuite`,
`addCase`, `promoteRun`, `runSuite`, `trend`, `proposeTune`, `applyTune`, `listTunes`, `revertTune`.

## Konfiguration

```yaml
evals:
  enabled: true          # Hauptschalter des Harness (sicher: nur lesen/bewerten)
  retainScores: 500      # max. gespeicherte Suite-Werte pro Suite (älteste zuerst entfernt)
  weights:               # zu einem Wert von 0..1 kombiniert (intern normalisiert)
    passRate: 0.5
    cost: 0.2
    intervention: 0.15
    similarity: 0.15
  costCeiling: 0.05      # $ als schlechtest-akzeptable Kosten pro Aufgabe
  autotune:
    enabled: false       # standardmäßig AUS — der Tuner verändert die Konfiguration
    minImprovement: 0.02 # minimaler Wertgewinn, den ein Vorschlag liefern muss
    maxProposals: 8      # Schutz vor Ausuferung
    autoApply: false     # übernommene Vorschläge automatisch anwenden (sonst Freigabe nötig)
```

Das Web-UI-Panel **Evaluierungen & Auto-Tuning** (Admin) listet Suiten und Fälle auf, befördert
Läufe, führt eine Suite aus, stellt den Scorecard-Verlauf dar und steuert den
Vorschlagen/Anwenden/Rückgängig-Workflow für Anpassungen.
