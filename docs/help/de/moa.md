# Mixture-of-Agents (`mercury moa`)

Sendet **denselben** Prompt parallel an mehrere **Proposer**-Modell-Slots, sammelt deren Vorschläge und
erzeugt daraus eine einzige finale Antwort. MoA ist eine natürliche Erweiterung des Jev-Routers und der
Teams: Ein „Modell-Slot“ ist dieselbe `"<provider>/<model>"`-ID (oder der Router-Alias `"auto"`), die der
Rest von Mercury verwendet, und jeder Proposer-/Aggregator-Aufruf läuft über **dasselbe** LLM-Gateway
(Routing, RBAC, Budgets, Nutzungs-Ledger). MoA setzt die Aggregation obendrauf — es fügt keinen zweiten
LLM-Mechanismus hinzu.

## Eine Abfrage ausführen — `mercury moa "<prompt>"`

```
mercury moa "Was ist die Hauptstadt von Frankreich?"
mercury moa "Entwirf eine Release-Notiz für v2" --proposers openai/gpt-4o,anthropic/claude-sonnet-4-5 --aggregator openai/gpt-4o
mercury moa "Ist diese Aussage wahr?" --strategy vote --proposers auto,auto,auto
mercury moa "Fasse das Design zusammen" --show-proposals --json
```

## Strategien

- **synthesize** (Standard) — ein **Aggregator**-Modell-Slot liest alle erfolgreichen Vorschläge und
  schreibt die einzige finale Antwort. Bevorzugt, wenn das beste Modell die Vorschläge abgleichen und
  zusammenführen soll.
- **vote** — Mehrheit / Selbstkonsistenz: Antworten werden (gross-/kleinschreibungs- und
  leerraumunabhängig) gruppiert, und die Gruppe mit den meisten Proposern gewinnt; Gleichstände werden
  nach erstem Auftreten entschieden. **Es erfolgt kein Aggregator-Aufruf.** Wiederhole denselben Slot
  (z. B. `--proposers auto,auto,auto`) für Selbstkonsistenz-Sampling.

## Optionen

- `--proposers a,b,c` — kommagetrennte Proposer-Modell-Slots (`"<provider>/<model>"` oder `"auto"`).
  Standard ist die Konfigurationsliste `moa.proposers`, sonst das Standardmodell. Derselbe Slot darf
  wiederholt werden.
- `--aggregator <slot>` — Aggregator-Modell-Slot für `synthesize` (Standard: Konfiguration
  `moa.aggregator`).
- `--strategy synthesize|vote` — Aggregationsstrategie (Standard: Konfiguration `moa.strategy`).
- `--system <text>` — optionaler System-Prompt, der jedem Proposer-Aufruf vorangestellt wird.
- `--show-proposals` — gibt zusätzlich jede Proposer-Antwort (und etwaige Fehler) vor der finalen Antwort
  aus.
- `--json` — gibt das vollständige strukturierte Ergebnis aus: jeden Vorschlag (mit Status),
  Stimmauszählungen, Zähler und die finale Antwort.

## Konfiguration (`moa.*`)

```yaml
moa:
  proposers: []          # Standard-Proposer-Slots; leer → Standardmodell verwenden
  aggregator: auto       # Standard-Aggregator-Slot für synthesize
  strategy: synthesize   # Standardstrategie: synthesize | vote
```

Optionen überschreiben stets die Konfiguration.

## Graceful Degradation

Ein Proposer, der einen Fehler wirft, wird **erfasst, nicht fatal** — der Lauf fährt mit den
erfolgreichen Vorschlägen fort (wie bei Teams). Das Ergebnis meldet `usedProposers` / `failedProposers`.
Wenn **alle** Proposer fehlschlagen (oder alle Antworten leer sind), bricht der Befehl mit einem
Exit-Code ungleich null ab, da es nichts zu aggregieren gibt.

## Hinweis zu echten Modellen

Die Aggregations-, Abstimmungs- und Fan-out-Logik ist rein und vollständig offline getestet. Wenn du
`mercury moa` live ausführst, treffen die Proposer- und Aggregator-Aufrufe über das normale LLM-Gateway
**echte** Modelle und benötigen Provider-Zugangsdaten — zur Laufzeit wird nichts gemockt.
