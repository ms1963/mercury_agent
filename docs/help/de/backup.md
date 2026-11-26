# Sicherung / Wiederherstellung

Vollständige Sicherung und Wiederherstellung einer Mercury-Instanz. Eine Sicherung ist ein vollständiger,
integritätsgeprüfter Snapshot des Mercury-Home-Verzeichnisses dieser Instanz (standardmäßig `~/.mercury`),
geschrieben als ein einziges gzip-JSON-Archiv mit der Endung `.mbak`: Konfiguration, die Speicher-Datenbank
(samt `-wal`/`-shm`-Dateien), Skills, Add-ins, Berechtigungsprofile, Plugins, Wiki und Bundles.

## Sicherung erstellen — `mercury backup`

- `mercury backup` — schreibt eine Sicherung des Mercury-Home in eine Datei `.mbak` mit Zeitstempel im aktuellen Verzeichnis.
- `mercury backup --out <datei>` — schreibt das Archiv stattdessen an einen bestimmten Pfad.
- `mercury backup --include-secrets` — sichert zusätzlich die Geheimnis-Dateien (`.env`, `audit.key`). Standardmäßig ausgeschlossen.
- `mercury backup --json` — gibt das Manifest samt Digest/Signatur als JSON aus.

## Sicherung prüfen — `mercury backup inspect <datei>`

Prüft ein Archiv und gibt seine Metadaten aus, **ohne etwas wiederherzustellen**:

- Inhalts-Digest gültig (Manipulations-/Korruptionsprüfung),
- jede einzelne Datei-SHA-256 gültig,
- Signatur `VALID` / `INVALID` / `absent` (`INVALID` bedeutet in der Regel, dass das Archiv von einer
  anderen Instanz stammt, da es mit dem Audit-Schlüssel dieser Instanz signiert ist),
- Kompatibilität mit dieser Mercury-Version,
- Erstellungszeitpunkt, Mercury-Version, Formatversion, Dateianzahl, Gesamtgröße und ob Geheimnisse enthalten sind.

`--json` liefert das strukturierte Ergebnis.

## Sicherung wiederherstellen — `mercury import <datei>`

`mercury import <datei>` (Alias: `mercury restore <datei>`) stellt ein Archiv in das Mercury-Home wieder her.

- Die Wiederherstellung **weigert sich, vorhandene Dateien zu überschreiben**, sofern nicht `--force` übergeben wird.
- Mit `--force` schreibt Mercury **zuerst eine Sicherheitssicherung vor der Wiederherstellung** des aktuellen
  Home (inklusive Geheimnisse) neben dem Datenverzeichnis, sodass die Wiederherstellung umkehrbar ist, und
  meldet deren Pfad.
- Die Integrität wird **vor jedem Schreibvorgang** geprüft — ein korruptes oder manipuliertes Archiv wird
  abgelehnt und nichts wird wiederhergestellt (die Wiederherstellung erfolgt bezüglich der Manipulationserkennung
  als Ganzes oder gar nicht).
- `--json` liefert `{ restored: [...], preRestoreBackup?: pfad }`.

Starte Mercury nach einer Wiederherstellung neu, damit die wiederhergestellte Konfiguration und Daten übernommen werden.

## Das `.mbak`-Format

Eine `.mbak`-Datei ist ein gzip-JSON-Dokument mit einem `manifest` (Metadaten samt Datei-Inhaltsverzeichnis:
relativer Pfad, Modus, Byte-Länge und SHA-256), einer `files`-Zuordnung `pfad -> base64(inhalt)`, einem
Inhalts-`digest` (SHA-256 des kanonischen manifest+files) und einer optionalen HMAC-`signature`, die mit dem
Audit-Schlüssel der Instanz berechnet wird. Der Builder sortiert Einträge und Datei-Schlüssel, und gzip
schreibt einen Null-Zeitstempel, sodass Sicherungen deterministisch sind: identische Eingaben erzeugen
identische Bytes.

## Standardmäßiger Ausschluss von Geheimnissen

Standardmäßig werden die beiden geheimnishaltigen Dateien (`.env`, `audit.key`) **ausgeschlossen**, sodass
eine Sicherung gefahrlos weitergegeben oder außerhalb des Systems gespeichert werden kann. Mit
`--include-secrets` erhältst du einen vollständigen Notfall-Snapshot. Flüchtige Dateien (`*.log`, `*.mbak`,
Sockets, PIDs, temporäre Dateien, `node_modules/`, `.git/`) und Symlinks werden stets ausgeschlossen.

## Hinweis zur laufenden Datenbank

Die Sicherung funktioniert bei laufendem Server; die SQLite-Dateien `-wal`/`-shm` sind enthalten, sodass ein
Online-Snapshot wiederherstellbar ist. Für einen vollständig konsistenten Datenbank-Snapshot kannst du den
Server zuvor stoppen, erforderlich ist dies jedoch nicht.
