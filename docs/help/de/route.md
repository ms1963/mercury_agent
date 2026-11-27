# Kriterienbasiertes Modell-Routing

`mercury route` verwaltet eine Liste von **`provider/model`-Einträgen, die jeweils mit den Kriterien
versehen sind, die sie bedienen**. Für jede Aufgabe, jeden Chat und jeden Workflow-Aufruf wählt Mercury
den **spezifischsten Eintrag, dessen Kriterien alle erfüllt sind**, und verwendet dieses Modell. Das ist
eine deklarative Art zu sagen: „Code an dieses Modell, günstigen Small Talk an jenes, private Arbeit an
ein lokales Modell."

Das Routing wird in der Konfigurationsdatei unter `llm.routing:` gespeichert. Das gewählte Modell wird
dem Router als explizites Modell übergeben, durchläuft also weiterhin die RBAC **und** profitiert
weiterhin von der automatischen Fallback-Kette (`mercury fallback`), falls es sich als nicht verfügbar
erweist.

## Kriterien-Vokabular

Die Kriterien verwenden das vorhandene **Profil-Tag-Vokabular**:

`general`, `code`, `reasoning`, `fast`, `cheap`, `vision`, `local`, `private`

Eine Anfrage trägt die ihr ausdrücklich zugewiesenen Tags sowie aus dem Inhalt abgeleitete Tags. Ein
Eintrag passt **nur, wenn jedes seiner Kriterien** in der Anfrage vorhanden ist (UND-Semantik); passen
mehrere Einträge, gewinnt der mit den **meisten Kriterien**. Ein Eintrag **ohne Kriterien oder mit genau
`default`** ist der universelle **Auffang-Eintrag**, der genutzt wird, wenn nichts Spezifischeres passt.

## Verwendung

```
mercury route list [--json]
mercury route add <provider> <model> [kriterien...]
mercury route remove <provider> <model> --force
mercury route clear --force
```

- `list` — die Routing-Kette anzeigen, jeden Eintrag mit seinen Kriterien (oder `default (catch-all)`).
  `--json` für Rohdaten.
- `add <provider> <model> [kriterien...]` — einen Eintrag für dieses Paar mit den angegebenen Kriterien
  hinzufügen oder ersetzen.
- `remove <provider> <model>` — einen passenden Eintrag löschen; erfordert `--force`.
- `clear` — die gesamte Routing-Kette entfernen; erfordert `--force`.

## Konfiguration (`~/.mercury/config.yaml`)

```yaml
llm:
  defaultModel: openai/gpt-4o-mini
  routing:
    - { provider: anthropic, model: claude-sonnet-4-5, criteria: [code, reasoning] }
    - { provider: openai, model: gpt-4o-mini, criteria: [fast, cheap] }
    - { provider: ollama, model: llama3.1, criteria: [private, local] }
    - { provider: chatllm, model: route-llm, criteria: [default] }   # Auffang-Eintrag
```

## Beispiel

```
mercury route add anthropic claude-sonnet-4-5 code reasoning
mercury route add openai gpt-4o-mini fast cheap
mercury route add chatllm route-llm default
mercury route list
```
