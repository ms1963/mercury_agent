# Teilbare Agenten-Bundles („Mercury-Packs")

Ein Bundle verpackt eine Mercury-Konfiguration — ein Skill-Set, Workflows, Persönlichkeit,
Policy-as-Code und MCP-Voreinstellungen — in ein einziges **versioniertes, signiertes** Artefakt,
das Sie einer anderen Instanz übergeben und mit einem Befehl installieren können. Bundles sind
**standardmäßig an** (`bundles.enabled: true`).

## Was in einem Bundle steckt

Ein Bundle ist eine JSON-Datei mit einem `manifest`, den `contents` (nur die enthaltenen Abschnitte)
und einer `signature`. Die Abschnitte sind:

| Abschnitt     | Quell-Konfigurationsschlüssel | Reguliert |
|---------------|-------------------------------|-----------|
| `skills`      | `skills`                      | nein      |
| `workflows`   | `workflows`                   | nein      |
| `personality` | `agent.personality`           | nein      |
| `policy`      | `security.policies`           | **ja**    |
| `mcp`         | `mcp.servers`                 | **ja**    |

## Export

Exportieren Sie die aktuelle Konfiguration (oder eine gewählte Teilmenge der Abschnitte) in ein
Bundle. Das Manifest hält die eigene Version des Bundles, die **Format-Version** des Wire-Formats und
die **Mercury-Version** fest, aus der es exportiert wurde. Das gesamte `{manifest, contents}` wird mit
HMAC-SHA256 signiert.

## Prüfen und installieren

**Prüfen** zeigt das Manifest, den Inhalts-Digest, ob die Signatur verifiziert und ob Format/Version
kompatibel sind — ohne etwas zu ändern.

**Installieren** ist durch Konstruktion sicher:

- **Signaturprüfung.** Mit `requireSignature: true` wird ein Bundle, dessen Signatur fehlt oder nicht
  verifiziert, abgelehnt — die Manipulation auch nur eines Bytes der Inhalte macht die Signatur
  ungültig.
- **Versions-/Kompatibilitätsprüfung.** Ein Bundle aus einem neueren Wire-Format-Major wird
  verweigert.
- **Idempotent.** Installationen werden über den Inhalts-Digest geschlüsselt; eine erneute
  Installation desselben Bundles ist ein No-Op (`alreadyInstalled`, Status `unchanged`).
- **Regulierte Abschnitte laufen über die Freigabe.** Die nicht regulierten Abschnitte (Skills,
  Workflows, Persönlichkeit) werden direkt angewendet; `policy` und `mcp` werden **zur Freigabe
  eingereiht** statt still angewendet zu werden, sofern nicht `autoApprovePolicy` /
  `autoApproveMcp` ausdrücklich eingeschaltet sind.

## CLI

```
mercury bundle list                                               installierte Bundles (Ledger)
mercury bundle export <name> [--version v] [--sections a,b,c] [--out datei] [--desc ...] [--author ...]
mercury bundle inspect <datei>                                    Signatur + Kompatibilität prüfen
mercury bundle install <datei>                                    prüfen → installieren (reguliert)
```

Fügen Sie jedem Unterbefehl `--json` für maschinenlesbare Ausgabe hinzu.

## API

- `GET /api/bundles` — Status, Konfiguration und das Installations-Ledger.
- `POST /api/bundles/export {name, version?, sections?, description?, author?}` — exportieren und
  signieren.
- `POST /api/bundles/inspect` — ein gesendetes Bundle prüfen, ohne es zu installieren.
- `POST /api/bundles/install {bundle, source?}` — verifizieren und installieren.
- `POST /api/bundles/:id/approve` — die von einer Installation eingereihten regulierten Abschnitte
  freigeben.

Programmatisch wird dasselbe über die Fassade `mercury.bundles` bereitgestellt: `export`,
`exportToFile`, `read`, `inspect`, `install`, `approvePending`, `list`.

## Konfiguration

```yaml
bundles:
  enabled: true                               # Hauptschalter (Fassade, CLI und Endpunkte)
  dir: ''                                      # Speicherverzeichnis; leer → <dataDir>/bundles
  signingSecret: 'mercury-bundle-default-key'  # HMAC-Signaturgeheimnis — in Produktion überschreiben
  requireSignature: true                       # fehlende/ungültige Signaturen ablehnen (Manipulationsschutz)
  autoApprovePolicy: false                     # gebündelte Richtlinien sofort anwenden (sonst einreihen)
  autoApproveMcp: false                        # gebündelte MCP-Voreinstellungen sofort anwenden (sonst einreihen)
```

Das Web-UI-Panel **Agenten-Bundles** (Admin) exportiert und lädt ein Bundle herunter, prüft oder
installiert eines (JSON einfügen oder Datei wählen) und listet installierte Bundles mit einer
Freigabeaktion für regulierte Abschnitte auf.
