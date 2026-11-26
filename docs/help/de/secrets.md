# Externe Secret-Speicher

Löst Secrets aus **externen Speichern** auf, statt Klartext in die Konfiguration zu schreiben. Ein
Konfigurationswert kann eine Secret-**Referenz** — `${SECRET:...}` — enthalten, die Mercury zur
**Verbindungszeit** zum echten Wert auflöst (zum Beispiel unmittelbar bevor ein MCP-Server gestartet wird).
Die Konfigurationsdatei enthält immer nur die Referenz, niemals das Secret selbst.

Das ergänzt die `${ENV_VAR}`-Ersetzung der MCP-Presets, statt sie zu ersetzen: `${ENV_VAR}` wird einmalig
beim Aktivieren des Presets ersetzt und der konkrete Wert gespeichert; `${SECRET:...}` bleibt in der
Konfiguration und wird bei jedem Lauf live aufgelöst. Beide existieren nebeneinander — die
Secret-Auflösung berührt ausschließlich `${SECRET:...}` und lässt reine `${ENV_VAR}`-Platzhalter
unangetastet.

## Referenz-Syntax

- `${SECRET:backend:key}` — löst `key` über das angegebene `backend` auf
  (z. B. `${SECRET:op:op://vault/item/field}`).
- `${SECRET:key}` — löst `key` über das **Standard-Backend** auf (Konfiguration `secrets.defaultBackend`,
  Standard `env`).

Eine an `mercury secrets get` übergebene Referenz kann die bloße innere Angabe (`backend:key` oder `key`)
oder die vollständige `${SECRET:...}`-Hülle sein.

## Backends

Ein Backend bildet einen Schlüssel auf einen Wert ab. Eingebaut:

- **env** — liest aus der Prozessumgebung. Immer verfügbar.
- **bitwarden** — das Bitwarden-CLI: `bw get password <key>`. Aktivierbar über `secrets.bitwarden.enabled`.
- **onepassword** — das 1Password-CLI: `op read <op://vault/item/field>`. Aktivierbar über
  `secrets.onepassword.enabled`.

Die externen CLI-Backends rufen ihr Werkzeug über einen injizierten Kommando-Runner auf, sodass Unit-Tests
niemals wirklich ein Programm starten. Aliase werden auf der Kommandozeile und in Referenzen akzeptiert:
`bw` → `bitwarden`, `op` / `1password` → `onepassword`.

## Konfiguration

Füge der Konfiguration einen Abschnitt `secrets` hinzu (alle Felder optional):

```yaml
secrets:
  defaultBackend: env            # Backend für ein bloßes ${SECRET:key}
  bitwarden:
    enabled: false               # auf true setzen, um ${SECRET:bw:...} zu nutzen
    command: bw                  # CLI-Binary/-Pfad überschreiben
  onepassword:
    enabled: false               # auf true setzen, um ${SECRET:op:...} zu nutzen
    command: op
```

Nur aktivierte Backends stehen dem Resolver zur Verfügung, sodass eine Referenz niemals einen Speicher
voraussetzt, den der Betreiber nicht aktiviert hat. `env` ist immer vorhanden.

## Backends — `mercury secrets backends`

Listet die konfigurierten Backends und ob sie gerade verfügbar sind (z. B. ob das CLI installiert ist).
Das Standard-Backend ist mit `*` markiert.

- `mercury secrets backends` — menschenlesbare Tabelle.
- `mercury secrets backends --json` — gibt pro Backend `{ name, describe, available, default }` aus.

## Auflisten — `mercury secrets list`

Durchsucht die **aktive Konfiguration** nach `${SECRET:...}`-Referenzen und meldet für jede den
Auflösungsstatus, mit maskiertem Wert.

- `mercury secrets list` — menschenlesbare Tabelle (`resolved` / `UNRESOLVED`, die Referenz sowie ein
  maskierter Wert oder der Fehler).
- `mercury secrets list --json` — gibt pro Referenz `{ ref, backend, key, status, value, error? }` aus
  (`value` ist immer maskiert).

Beendet sich mit einem Fehlercode ungleich null, wenn eine Referenz nicht aufgelöst werden kann.

## Abrufen — `mercury secrets get <ref>`

Löst eine einzelne Referenz auf und gibt sie aus. **Der Wert ist standardmäßig maskiert** — nur `--reveal`
gibt das rohe Secret aus.

- `mercury secrets get env:API_KEY` — gibt `********` aus (aufgelöst, aber maskiert).
- `mercury secrets get env:API_KEY --reveal` — gibt den rohen Wert aus (sensibel — in geteilten Terminals
  oder Logs vermeiden).
- `mercury secrets get '${SECRET:op:op://v/i/f}'` — die vollständige Hüllenform wird ebenfalls akzeptiert.
- `--json` — gibt `{ ref, backend, key, status, revealed, value }` aus (Wert maskiert, außer bei
  `--reveal`).

Beendet sich mit einem Fehlercode ungleich null (und gibt einen Fehler aus), wenn die Referenz nicht
aufgelöst werden kann.

## Auflösen — `mercury secrets resolve [--config <path>]`

Durchsucht eine Konfiguration und meldet maskiert, welche `${SECRET:...}`-Referenzen sich auflösen lassen.
Ohne `--config` wird die aktive Konfiguration durchsucht; mit `--config <path>` der Text dieser Datei
(formatunabhängig).

- `mercury secrets resolve` — die aktive Konfiguration durchsuchen.
- `mercury secrets resolve --config ./mcp.yaml` — eine bestimmte Datei durchsuchen.
- `--json` — gibt `{ source, refs: [{ ref, backend, key, status, value, error? }] }` aus.

Beendet sich mit einem Fehlercode ungleich null, wenn eine Referenz nicht aufgelöst werden kann.

## Sicherheit

Kein Befehl speichert oder protokolliert jemals ein Klartext-Secret. Die Ausgabe ist überall standardmäßig
maskiert; der **einzige** Weg, einen rohen Wert auszugeben, ist `mercury secrets get --reveal`. Zur
Verbindungszeit bleibt eine nicht auflösbare Referenz an Ort und Stelle (damit der Fehler sichtbar ist),
und es wird nur die **Anzahl** nicht aufgelöster Referenzen protokolliert — niemals die Schlüssel oder
Werte.

## Exit-Codes

`0` bei Erfolg. `secrets get` endet mit einem Code ungleich null, wenn die Referenz nicht aufgelöst werden
kann; `secrets list` und `secrets resolve` enden mit einem Code ungleich null, wenn eine Referenz nicht
aufgelöst wird; ein unbekannter Unterbefehl endet mit einem Code ungleich null.

## Integration zur Verbindungszeit

Beim Start von Mercury werden MCP-Server-Konfigurationen vor dem Start der Server durch den Resolver
expandiert, sodass `${SECRET:...}`-Referenzen in `command`, `args`, `env` oder `headers` eines Servers zu
echten Werten im gestarteten Prozess werden — ohne dass das Secret jemals auf die Festplatte geschrieben
wird. Derselbe Resolver ist als Bibliothek verfügbar (`secretResolverFromConfig`, `expandSecretsDeep`,
`scanSecretRefs`) und wird direkt von `mercury secrets resolve` genutzt.
