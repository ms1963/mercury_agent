# Shell-Hooks

`mercury hooks` führt einen konfigurierten **Shell-Befehl bei einem echten Lebenszyklus-Ereignis** aus
(Lauf-Start/-Ende, Tool-Aufrufe, Speicher-Schreibvorgänge, …). Jeder Hook, der einen Befehl startet,
wird **vor dem Start durch die Freigabe-Schicht** geleitet — dasselbe Gate, das jeder andere
Shell-Aufruf in Mercury nutzt — sofern du dich nicht pro Hook mit `--no-approval` ausdrücklich
abmeldest.

Hooks werden in der Konfigurationsdatei unter `hooks:` gespeichert (als Einträge mit `type: shell`).
Sie werden zur Laufzeit automatisch beim gebundenen Ereignis ausgelöst und können zum Testen auch
manuell mit `hooks run` ausgelöst werden.

## Lebenszyklus-Ereignisse

Ein Hook bindet sich an einen der echten Abfangpunkte (auflisten mit `mercury hooks events`):

- `run_start`, `run_end` — ein Agenten-Lauf beginnt / endet
- `before_llm_call`, `after_llm_call` — rund um jeden Modellaufruf
- `before_tool_call`, `after_tool_call` — rund um jeden Tool-Aufruf
- `message_received`, `message_sent` — Gateway-Verkehr
- `output` — endgültige Ausgabe erzeugt
- `memory_write` — ein Speicherelement wird geschrieben
- `attachment_scan` — ein Anhang wird geprüft
- `error` — ein Lauf schlägt fehl

Mit `*` bindet sich ein Hook an **jedes** Ereignis.

## An den Befehl übergebene Umgebung

Der Befehl läuft über `sh -c` mit der aktuellen Umgebung plus diesen Variablen (nur die vom auslösenden
Ereignis tatsächlich mitgeführten sind gesetzt; `MERCURY_HOOK_EVENT` und `MERCURY_HOOK_TS` sind immer
gesetzt):

`MERCURY_HOOK_EVENT`, `MERCURY_HOOK_TS`, `MERCURY_RUN_ID`, `MERCURY_SESSION_ID`, `MERCURY_USER_ID`,
`MERCURY_TOOL`, `MERCURY_MODEL`, `MERCURY_STATUS`, `MERCURY_PLATFORM`.

## Verwendung

```
mercury hooks list [--json]
mercury hooks events [--json]
mercury hooks add <name> --event <event> --command <cmd> [--no-approval] [--disabled]
mercury hooks remove <name> [--force]
mercury hooks run <name> [--json]
```

- `list` — konfigurierte Shell-Hooks anzeigen (Name, Ereignis, aktiviert, Freigabe, Befehl). `--json`
  für Rohdaten.
- `events` — die unterstützten Lebenszyklus-Ereignisnamen auflisten. `--json` für Rohdaten.
- `add <name>` — einen Hook registrieren (oder überschreiben). `--event` und `--command` sind
  erforderlich; `--no-approval` führt ihn ohne Freigabe-Gate aus; `--disabled` registriert ihn inaktiv.
- `remove <name>` — einen Hook löschen; erfordert `--force`.
- `run <name>` — einen Hook jetzt zum Testen auslösen (weiterhin freigabepflichtig). Gibt das Ergebnis
  plus etwaige stdout/stderr aus; beendet mit Code ungleich null, wenn der Hook abgelehnt wird,
  fehlschlägt oder einen Fehler wirft.

## Sicherheit

Shell-Hooks führen **beliebige Befehle auf dem Host** aus. Die Freigabe ist **standardmäßig aktiv**;
`--no-approval` deaktiviert sie für einen einzelnen Hook — nutze das nur für vertrauenswürdige,
nicht-destruktive Befehle. Ein abgelehnter Hook wird nie gestartet; ein fehlschlagender oder
fehlerhafter Hook wird gemeldet, bringt den Lauf aber nie zum Absturz.
