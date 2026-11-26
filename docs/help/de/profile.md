# Profile / isolierte Instanzen

Verwaltet mehrere **vollständig isolierte** Mercury-Instanzen. Ein *Profil* ist eine benannte Instanz mit
eigenem **Home-Verzeichnis** (`MERCURY_HOME`) — und damit eigener Konfiguration, Speicher-Datenbank,
Skills, Plugins, Persönlichkeiten und eigenem Audit-Schlüssel. Zwischen Profilen wird nichts geteilt.
`mercury profile` baut auf Mercurys vorhandener Home-Verzeichnis-Indirektion (`MERCURY_HOME`) auf, statt
einen parallelen Mechanismus zu erfinden — es merkt sich lediglich, welches Profil aktiv ist, und löst
dessen Home beim nächsten Lauf auf.

**Profil vs. Projekt — die Schichtung.** Ein *Profil* wählt das **Home**; ein *Projekt* (innerhalb dieses
Homes) wählt das **Datenverzeichnis**. Sie stapeln sich:

```
profile  → wählt MERCURY_HOME                   (mercury profile)
  project → wählt das Datenverzeichnis darin     (mercury project)
```

Verwende ein **Profil** für eine völlig getrennte Instanz (z. B. beruflich vs. privat oder eine
Wegwerf-Sandbox); verwende ein **Projekt** für einen Arbeitsbereich, der dieselbe Instanz nutzt, aber
Speicher/Konfiguration pro Projekt begrenzt.

Profile werden in einer **Registry** unter `~/.config/mercury/profiles.json` geführt. Da Profile
*oberhalb* der Homes liegen, kann die Registry nicht in einem einzelnen Home liegen — sie liegt im
Konfigurationsverzeichnis (das Verzeichnis lässt sich mit `MERCURY_PROFILES_DIR` überschreiben). Jedes
Profil verwendet standardmäßig das Home `~/.mercury-profiles/<name>/` (die Basis lässt sich mit
`MERCURY_PROFILES_HOME` überschreiben), oder man gibt mit `--home` einen beliebigen Pfad an.

> **Das eingebaute Profil `default`** existiert immer und bildet auf das Standard-`~/.mercury` ab, sodass
> bestehende Einrichtungen völlig unberührt bleiben, bis man ein Profil erstellt. Es kann nicht erstellt,
> entfernt oder gelöscht (purge) werden.

> **Der Umschaltmechanismus (wichtig).** Ein Prozess kann die Umgebung seiner Eltern-Shell nicht ändern,
> daher tut `mercury profile use <name>` **zweierlei**: es speichert die Auswahl dauerhaft (neue
> Mercury-Prozesse übernehmen sie beim nächsten Lauf automatisch) **und** es gibt die exakte Zeile
> `export MERCURY_PROFILE=<name>` aus, um die Änderung sofort auf die *aktuelle* Shell anzuwenden — ganz
> wie `pyenv`/`direnv`. Führe diese Zeile aus (oder `eval`), um die aktive Instanz in der Shell, in der du
> gerade bist, umzuschalten.

> **Vorrang.** Ein explizites `MERCURY_HOME` hat immer Vorrang (Profile werden ignoriert). Andernfalls hat
> eine Umgebungsvariable `MERCURY_PROFILE` für diesen Lauf Vorrang vor dem gespeicherten aktiven Profil.

## Auflisten — `mercury profile list`

Listet jedes Profil auf — das eingebaute `default` zuerst, dann die eigenen Profile sortiert nach Namen
(Aktiv-Markierung, Name, Home-Verzeichnis, „home missing“, wenn es gelöscht wurde, und Beschreibung).

- `mercury profile list` — menschenlesbare Tabelle; das aktive Profil ist mit `*` markiert.
- `mercury profile list --json` — gibt die Profile als JSON aus: pro Profil `{ name, home, description,
  createdAt, updatedAt, builtin, isActive, homeExists }`.

## Erstellen — `mercury profile create <name>`

Erstellt ein Profil und sein Home-Verzeichnis und registriert es.

- `mercury profile create work` — `work` mit dem Standard-Home `~/.mercury-profiles/work/` erstellen.
- `mercury profile create work --use` — erstellen und sofort aktiv setzen.
- `mercury profile create work --home /srv/mercury/work` — ein explizites Home-Verzeichnis statt des
  Standards verwenden.
- `mercury profile create work --desc "Arbeitsinstanz"` — eine kurze Beschreibung anhängen.
- `--json` — gibt das erstellte Profil als JSON aus.

Namen müssen ein einzelnes sicheres Segment sein (Buchstaben, Ziffern, `.`, `_`, `-`; höchstens 64
Zeichen; keine Pfadtrenner, kein `..`, kein führender Punkt). Ein bereits existierender Name — oder der
reservierte Name `default` — wird abgelehnt.

## Verwenden — `mercury profile use <name>`

Schaltet das aktive Profil um. Die Änderung wird in die Registry geschrieben (sodass neue Prozesse sie
übernehmen), und der Befehl gibt die Zeile `export MERCURY_PROFILE=<name>` aus, um sie sofort auf die
aktuelle Shell anzuwenden.

- `mercury profile use work` — `work` aktiv setzen und die Export-Zeile ausgeben.
- `mercury profile use default` — zurück zur Standardinstanz `~/.mercury` wechseln.
- `--json` — gibt `{ active, home, export }` aus.

## Anzeigen — `mercury profile show [name]`

Zeigt die Details eines Profils: Home-Verzeichnis (und ob es existiert), die Anzahl der aktuell darin
enthaltenen Einträge, Beschreibung und Erstellungszeit. Ohne Namen wird das **aktive** Profil angezeigt
(das eingebaute `default`, wenn keines ausgewählt ist, da dies die effektiv laufende Instanz ist).

- `mercury profile show` — das aktive (oder das default) Profil anzeigen.
- `mercury profile show work` — das Profil mit dem Namen `work` anzeigen.
- `--json` — gibt die Details (plus `homeEntries`) als JSON aus.

Ein unbekanntes Profil zu nennen ist ein Fehler.

## Aktuell — `mercury profile current`

Gibt nur den Namen des aktiven Profils aus (`default`, wenn keines ausgewählt ist).

- `mercury profile current` — den aktiven Namen ausgeben.
- `mercury profile current --json` — `{ active }` ausgeben.

## Entfernen — `mercury profile remove <name>`

Hebt die Registrierung eines Profils auf. **Destruktiv, daher ist eine Bestätigung erforderlich:**

- `mercury profile remove work --force` (oder `--yes`) — die Registrierung von `work` aufheben.
  Standardmäßig **bleibt das Home-Verzeichnis** auf der Festplatte erhalten (nur der Registry-Eintrag wird
  entfernt), sodass das Profil zur Wiederherstellung neu erstellt werden kann.
- `mercury profile remove work --force --purge` — zusätzlich das Home-Verzeichnis des Profils von der
  Festplatte löschen (extra-destruktiv — dies kann nicht rückgängig gemacht werden). Als Sicherheitsnetz
  wird das Standard-`~/.mercury` niemals gelöscht.
- Ohne `--force`/`--yes` verweigert der Befehl und beendet sich mit einem Code ungleich null (dieselbe
  Absicherung wie `mercury project remove` / `mercury sessions delete` / `mercury plugins remove`).
- Das `default`-Profil kann nicht entfernt werden.
- `--json` — gibt `{ name, home, purged, wasActive }` aus.

Das Entfernen des aktiven Profils löscht die Aktiv-Auswahl (danach ist das `default`-Profil aktiv).

## Exit-Codes

`0` bei Erfolg. Ein fehlender Name, ein Duplikat beim Erstellen, ein ungültiger oder reservierter Name,
ein unbekanntes Profil bei `use`/`show`/`remove`, ein Entfernen ohne `--force`, das Entfernen von
`default` sowie ein unbekannter Unterbefehl beenden sich jeweils mit einem Code ungleich null.

## Speicherung

Die Registry ist `~/.config/mercury/profiles.json` (das Verzeichnis lässt sich mit
`MERCURY_PROFILES_DIR` überschreiben). Profil-Homes verwenden standardmäßig `~/.mercury-profiles/<name>/`
(die Basis lässt sich mit `MERCURY_PROFILES_HOME` überschreiben, oder man setzt pro Profil mit `--home`
einen expliziten Pfad); das eingebaute `default`-Profil bildet auf `~/.mercury` ab. Die
Home-Verzeichnis-Indirektion bleibt unverändert — dieser Befehl merkt sich nur, welches Profil aktiv ist,
und löst dessen Home auf; alles, was Mercury ohnehin am Home festmacht (Konfiguration, Speicher-DB,
Plugins, Skills, Audit-Schlüssel), wird dadurch pro Profil isoliert.
