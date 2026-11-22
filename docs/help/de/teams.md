# Teams (Multi-Agenten-Orchestrierung)

Teams fassen mehrere rollenspezialisierte Agenten zu einem gesteuerten, budgetbewussten Lauf
zusammen. Ein Team ist eine benannte, dauerhaft gespeicherte Definition aus **Mitgliedern** (je mit
Rolle, optionalem Modell/Muster/Toolset und einer Aufgabenvorlage) sowie einer **Strategie**, die
die Zusammenarbeit bestimmt.

Teams sind **standardmäßig deaktiviert**. Aktivierung in `config.yaml`:

```yaml
teams:
  enabled: true
  maxMembers: 8
  defaultStrategy: coordinator   # coordinator | pipeline | debate
  budget: 0                      # 0 = keine Obergrenze pro Lauf; sonst maximale Gesamtkosten
  requireApproval: false         # jeden Lauf hinter einer Freigabe absichern
```

## Strategien

- **coordinator** — das erste Mitglied plant und delegiert parallel an die übrigen Mitglieder
  (Worker); deren Ergebnisse werden zu einer Endantwort zusammengeführt.
- **pipeline** — Mitglieder laufen nacheinander, jedes erhält die Ausgabe des vorherigen als Kontext.
- **debate** — jedes Mitglied antwortet unabhängig, danach werden die Ergebnisse zusammengeführt
  (oder die längste/stärkste Antwort gewählt).

## Steuerung & Ausfallsicherheit

- Jeder Lauf prüft die Richtlinie `teams.run`; Anlegen/Löschen prüft `teams.manage` (Admin).
- Eine **Budget-Obergrenze pro Lauf** stoppt die Delegation an weitere Mitglieder, sobald das Limit
  erreicht ist; die übrigen Mitglieder werden als `skipped` erfasst.
- Mitgliederfehler **werden sanft aufgefangen** — ein abstürzendes Mitglied wird zum `error`-Schritt
  und der Lauf läuft weiter (Status `partial`), statt abzubrechen.
- Definitionen und Laufprotokolle werden dauerhaft gespeichert und sind auditierbar.

## CLI

```bash
mercury team create researchers --members "lead:plane die Recherche;writer:entwirf den Bericht" --strategy coordinator
mercury team list
mercury team run researchers "Fasse das letzte Release zusammen" --budget 2
mercury team runs
mercury team show researchers
mercury team delete researchers
```

## REST

`GET/POST /api/teams`, `GET/DELETE /api/teams/:id`, `POST /api/teams/:id/run`,
`GET /api/teams/runs`, `GET /api/teams/runs/:id` — alle mit Authentifizierung.
