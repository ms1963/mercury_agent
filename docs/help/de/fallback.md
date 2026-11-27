# Automatische Fallback-Kette

`mercury fallback` verwaltet eine **geordnete Liste von `provider/model`-Paaren**, die Mercury der Reihe
nach ausprobiert, sobald das primäre Modell **nicht verfügbar** ist. So bleibt der Agent antwortfähig,
wenn ein Backend ausfällt, falsch konfiguriert oder überlastet ist — ohne dein Standardmodell zu ändern.

Die Kette wird in der Konfigurationsdatei unter `llm.fallback:` gespeichert und **nach** den eigenen
Kandidaten des Routers angehängt. So ergänzen sich kriterienbasiertes Routing (`mercury route`) und die
Fallback-Kette: Der Router (oder ein `route`-Eintrag) wählt das Modell, und ist dieses nicht verfügbar,
übernimmt die Fallback-Kette.

## Was als „nicht verfügbar" gilt

Ein einzelner, zentraler Klassifikator entscheidet, wann zum nächsten Eintrag gewechselt wird. Er greift
**auf die Fallback-Kette zurück** bei:

- Modell nicht gefunden / unbekanntes Modell / unbekannter Anbieter / Fehlkonfiguration (404 und Konfigurationsfehler)
- falschem oder fehlendem API-Schlüssel (401 / 403, oder der Umgebungsschlüssel des Anbieters fehlt)
- abgelehnter Verbindung / Netzwerkfehler (z. B. ein lokales Backend wie Ollama läuft nicht)
- Rate-Limit / Überlastung (429 / 503 / 529 und andere vorübergehende 5xx)
- einem offenen Circuit Breaker für das Modell

Bei anfragebedingten Fehlern greift er **bewusst nicht** auf die Fallback-Kette zurück, da diese auf
jedem Modell erneut aufträten und deshalb an den Aufrufer weitergegeben werden:

- Kontextlänge / Prompt zu groß
- fehlerhafte Anfrage / ungültige Eingabe (400 / 422)
- Content-Policy- / Sicherheits-Ablehnungen

## Verwendung

```
mercury fallback list [--json]
mercury fallback add <provider> <model> [--base-url <url>]
mercury fallback remove <provider> <model> --force
mercury fallback clear --force
```

- `list` — die konfigurierte Kette in Reihenfolge anzeigen. `--json` für Rohdaten.
- `add <provider> <model>` — ein Paar anhängen (dedupliziert; Reihenfolge bleibt erhalten). `--base-url`
  hinterlegt einen optionalen Endpunkt-Hinweis am Eintrag.
- `remove <provider> <model>` — einen passenden Eintrag löschen; erfordert `--force`.
- `clear` — die gesamte Kette entfernen; erfordert `--force`.

## Konfiguration (`~/.mercury/config.yaml`)

```yaml
llm:
  defaultModel: openai/gpt-4o-mini
  fallback:
    - { provider: anthropic, model: claude-haiku-4-5 }
    - { provider: openai, model: gpt-4o-mini }
    - { provider: ollama, model: llama3.1 }        # letzte Instanz: lokal, immer verfügbar
```

Der referenzierte Anbieter muss konfiguriert sein (`llm.providers` / ein Umgebungsschlüssel), damit die
ID aufgelöst wird. Das Feld `baseUrl` wird für die Zukunftskompatibilität gespeichert; eine
Basis-URL-Überschreibung pro Eintrag wird bei der Anbieter-Erstellung noch nicht angewendet.

## Beispiel

```
mercury fallback add anthropic claude-haiku-4-5
mercury fallback add ollama llama3.1
mercury fallback list
```
