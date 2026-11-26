# Projekte / Arbeitsbereiche

Verwaltet benannte **Arbeitsbereiche**. Ein *Projekt* ist ein benannter Arbeitsbereich mit eigenem
**Datenverzeichnis**, sodass verschiedene Projekte niemals denselben Zustand teilen: im Datenverzeichnis
hält Mercury seine Speicher-Datenbank, Konfiguration, Plugins, Skills und den Audit-Schlüssel — es auf ein
projektspezifisches Verzeichnis zeigen zu lassen, begrenzt also **Konfiguration und Speicher** in einem
Schritt. `mercury project` baut auf Mercurys vorhandener Datenverzeichnis-Indirektion (`MERCURY_HOME` /
`MERCURY_DATA_DIR`) auf, statt einen parallelen Mechanismus zu erfinden — es merkt sich lediglich, welches
Projekt aktiv ist, und löst dessen Datenverzeichnis beim nächsten Lauf auf.

Projekte werden in einer **Registry** unter `~/.mercury/projects.json` geführt (dem Mercury-*Home*, nicht
dem Datenverzeichnis eines einzelnen Projekts — das Umschalten muss oberhalb der projektspezifischen
Verzeichnisse liegen). Jedes Projekt verwendet standardmäßig das Datenverzeichnis
`~/.mercury/projects/<name>/`, oder man gibt mit `--dir` einen beliebigen Pfad an.

> Das aktive Projekt wird beim **nächsten** Start von Mercury (oder dem Server) wirksam — das Umschalten
> verschiebt den laufenden Prozess nicht in ein anderes Datenverzeichnis. Ein explizites
> `MERCURY_DATA_DIR` oder eine Umgebungsvariable `MERCURY_PROJECT`, die ein registriertes Projekt nennt,
> hat Vorrang vor dem gespeicherten aktiven Projekt.

> Das Umschalten **migriert keine Daten**. Jedes Projekt behält seine eigene Speicher-DB, Konfiguration,
> Plugins und Skills; es gibt kein automatisches Kopieren zwischen Projekten.

## Auflisten — `mercury project list`

Listet jedes registrierte Projekt auf (Aktiv-Markierung, Name, Datenverzeichnis, „data dir missing“, wenn
es gelöscht wurde, und Beschreibung).

- `mercury project list` — menschenlesbare Tabelle; das aktive Projekt ist mit `*` markiert.
- `mercury project list --json` — gibt die Projekte als JSON aus: pro Projekt `{ name, dataDir, folders,
  description, createdAt, updatedAt, isActive, dataDirExists }`.

## Erstellen — `mercury project create <name>`

Erstellt ein Projekt, sein Datenverzeichnis und etwaige zusätzliche Ordner und registriert es.

- `mercury project create web` — `web` mit dem Standard-Datenverzeichnis `~/.mercury/projects/web/`
  erstellen.
- `mercury project create web --use` — erstellen und sofort aktiv setzen.
- `mercury project create web --dir /srv/mercury/web` — ein explizites Datenverzeichnis statt des
  Standards verwenden.
- `mercury project create web --folder ./frontend,./backend` — zusätzliche Arbeitsordner zuordnen
  (kommagetrennt; jeder wird angelegt, falls er fehlt).
- `mercury project create web --desc "Kundenportal"` — eine kurze Beschreibung anhängen.
- `--json` — gibt das erstellte Projekt als JSON aus.

Namen müssen ein einzelnes sicheres Segment sein (Buchstaben, Ziffern, `.`, `_`, `-`; höchstens 64
Zeichen; keine Pfadtrenner, kein `..`, kein führender Punkt). Ein bereits existierender Name wird
abgelehnt.

## Verwenden — `mercury project use <name>`

Schaltet das aktive Projekt um. Die Änderung wird in die Registry geschrieben und beim nächsten Lauf
wirksam.

- `mercury project use web` — `web` aktiv setzen.
- `--json` — gibt `{ active, dataDir }` aus.

## Anzeigen — `mercury project show [name]`

Zeigt die Details eines Projekts: Datenverzeichnis (und ob es existiert), die Anzahl der aktuell darin
enthaltenen Einträge, zugeordnete Ordner, Beschreibung und Erstellungszeit. Ohne Namen wird das **aktive**
Projekt angezeigt.

- `mercury project show` — das aktive Projekt anzeigen (oder einen Hinweis, wenn keines aktiv ist).
- `mercury project show web` — das Projekt mit dem Namen `web` anzeigen.
- `--json` — gibt die Details (plus `dataDirEntries`) als JSON aus.

Ein unbekanntes Projekt zu nennen ist ein Fehler; nach dem aktiven Projekt zu fragen, wenn keines gesetzt
ist, gibt einen Hinweis aus (und `{ "active": null }` bei `--json`).

## Aktuell — `mercury project current`

Gibt nur den Namen des aktiven Projekts aus oder `(none)`.

- `mercury project current` — den aktiven Namen oder `(none)` ausgeben.
- `mercury project current --json` — `{ active }` ausgeben (`null`, wenn keines).

## Entfernen — `mercury project remove <name>`

Hebt die Registrierung eines Projekts auf. **Destruktiv, daher ist eine Bestätigung erforderlich:**

- `mercury project remove web --force` (oder `--yes`) — die Registrierung von `web` aufheben.
  Standardmäßig **bleibt das Datenverzeichnis** auf der Festplatte erhalten (nur der Registry-Eintrag wird
  entfernt), sodass das Projekt zur Wiederherstellung neu erstellt werden kann.
- `mercury project remove web --force --purge` — zusätzlich das Datenverzeichnis des Projekts von der
  Festplatte löschen (extra-destruktiv — dies kann nicht rückgängig gemacht werden).
- Ohne `--force`/`--yes` verweigert der Befehl und beendet sich mit einem Code ungleich null (dieselbe
  Absicherung wie `mercury sessions delete` / `mercury plugins remove`).
- `--json` — gibt `{ name, dataDir, purged, wasActive }` aus.

Das Entfernen des aktiven Projekts löscht die Aktiv-Auswahl (danach ist kein Projekt aktiv).

## Exit-Codes

`0` bei Erfolg. Ein fehlender Name, ein Duplikat beim Erstellen, ein ungültiger Name, ein unbekanntes
Projekt bei `use`/`show`/`remove`, ein Entfernen ohne `--force` sowie ein unbekannter Unterbefehl beenden
sich jeweils mit einem Code ungleich null.

## Speicherung

Die Registry ist `~/.mercury/projects.json`. Projekt-Datenverzeichnisse verwenden standardmäßig
`~/.mercury/projects/<name>/` (oder wohin `--dir` zeigt). Die Datenverzeichnis-Indirektion bleibt
unverändert — dieser Befehl merkt sich nur, welches Projekt aktiv ist, und löst dessen Datenverzeichnis
auf; alles, was Mercury ohnehin am Datenverzeichnis festmacht (Speicher-DB, Konfiguration, Plugins,
Skills), wird dadurch pro Projekt begrenzt.
