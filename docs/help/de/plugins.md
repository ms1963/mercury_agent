# Plugin-Verwaltung

Verwaltet die Plugins, die Mercury aus `~/.mercury/plugins/` lädt. `mercury plugins` **listet** die in
diesem Lauf geladenen Plugins auf und **installiert / aktualisiert / entfernt** Plugins von einem lokalen
Pfad oder einer git-URL. Der Befehl baut auf Mercurys vorhandenem Plugin-Loader (`discoverPlugins` /
`loadPlugin`) und dem Generator (`mercury new plugin`) auf — er ändert nicht, wie Plugins erkannt oder
geladen werden.

Ein *Plugin* ist ein Verzeichnis unter `~/.mercury/plugins/<name>/` mit einem auffindbaren Einstiegspunkt
(`index.js`, `index.mjs`, `dist/index.js` oder ein `package.json`-Feld `main`/`module`, das auf eine
vorhandene Datei zeigt). Ein Ein-Datei-Plugin wird als `<name>/<name>.js` installiert.

Jedes über diesen Befehl installierte Plugin erhält ein **Installations-Manifest**
(`.mercury-plugin.json`) in seinem Verzeichnis, das festhält, woher es stammt (git-URL oder absoluter
Pfad), seine Version und Zeitstempel. `update` liest das Manifest, um zwischen einem `git pull` und einem
erneuten Kopieren vom aufgezeichneten Pfad zu entscheiden. Von Hand abgelegte Plugins (ohne Manifest)
werden weiterhin geladen und aufgelistet, können aber nicht aktualisiert werden.

> Änderungen werden beim nächsten Start von Mercury (oder dem Server) wirksam — das Installieren,
> Aktualisieren oder Entfernen eines Plugins lädt den laufenden Prozess nicht neu.

## Auflisten — `mercury plugins` / `mercury plugins list`

Listet die in diesem Lauf geladenen Plugins auf (Name, Version und etwaiger Ladefehler).

- `mercury plugins` — geladene Plugins auflisten (Kurzform).
- `mercury plugins list` — dasselbe.
- `mercury plugins list --json` — gibt die **installierten** Plugins (von der Festplatte, mit Manifest- und
  Einstiegspunkt-Informationen) als JSON aus: pro Plugin `{ name, path, version, source, entryPresent,
  managed }`.

## Installieren — `mercury plugins install <pfad|git-url>`

Installiert ein Plugin nach `~/.mercury/plugins/<name>/`.

- `mercury plugins install ./my-plugin` — ein lokales Plugin-Verzeichnis kopieren.
- `mercury plugins install ./my-plugin.js` — ein Ein-Datei-Plugin als `<name>/<name>.js` installieren.
- `mercury plugins install https://github.com/acme/cool-plugin.git` — das Repository per `git clone` holen.
- `mercury plugins install git@github.com:acme/cool-plugin.git` — git-URL im scp-Stil.
- `mercury plugins install git+https://github.com/acme/cool.git` — `git+`-Präfix (wird vor dem Klonen
  entfernt).

Optionen:

- `--name <name>` — den abgeleiteten Installationsnamen überschreiben. Standardmäßig ist der Name der
  Repo-Basisname (ohne `.git`) bei git bzw. der Verzeichnis-/Dateibasisname bei einem Pfad. Namen müssen
  ein einzelnes sicheres Segment sein (Buchstaben, Ziffern, `.`, `_`, `-`; keine Pfadtrenner, kein `..`,
  kein führender Punkt).
- `--force` — eine vorhandene Installation gleichen Namens überschreiben (entfernen + neu installieren).
  Ohne diese Option wird eine vorhandene Installation abgelehnt.
- `--build` — `npm install && npm run build` im Plugin-Verzeichnis ausführen, **nur wenn** es in seiner
  `package.json` ein `build`-Skript deklariert. (Berührt niemals das Mercury-Repository selbst.)
- `--json` — gibt `{ name, dir, source, version, built, reinstalled }` aus.

Eine lokale Quelle wird validiert, bevor etwas geschrieben wird: der Pfad muss existieren, und eine
Verzeichnisquelle muss tatsächlich wie ein Plugin aussehen (einen auffindbaren Einstiegspunkt haben). Eine
git-Quelle wird nach dem Klonen validiert; ein Repository, das nicht wie ein Plugin aussieht, wird wieder
entfernt und abgelehnt.

## Aktualisieren — `mercury plugins update <name>` / `--all`

Aktualisiert ein installiertes Plugin aus seiner aufgezeichneten Quelle (erfordert ein Manifest).

- `mercury plugins update cool-plugin` — `git pull --ff-only` bei einer git-Quelle oder erneutes Kopieren
  vom aufgezeichneten Pfad bei einer Pfadquelle.
- `mercury plugins update --all` — jedes *verwaltete* Plugin (mit Manifest) aktualisieren und jedes
  einzeln melden.
- `--json` — gibt das/die Aktualisierungsergebnis(se) aus.

Die Aktualisierung schlägt fehl, wenn das Plugin nicht installiert ist, kein Manifest hat oder (bei einer
Pfadquelle) sein ursprüngliches Quellverzeichnis nicht mehr existiert.

## Entfernen — `mercury plugins remove <name>`

Entfernt ein installiertes Plugin-Verzeichnis. **Destruktiv, daher ist eine Bestätigung erforderlich:**

- `mercury plugins remove cool-plugin --force` (oder `--yes`) — das Plugin-Verzeichnis löschen.
- Ohne `--force`/`--yes` verweigert der Befehl und beendet sich mit einem Code ungleich null (dieselbe
  Absicherung wie `mercury sessions delete`).
- `--json` — gibt `{ name, dir }` aus.

## Exit-Codes

`0` bei Erfolg. Eine fehlende Quelle, eine doppelte Installation ohne `--force`, ein unbekanntes/nicht
verwaltetes Plugin beim Aktualisieren, ein Entfernen ohne `--force` sowie ein unbekannter Unterbefehl
beenden sich jeweils mit einem Code ungleich null.

## Speicherung

Plugins liegen unter `~/.mercury/plugins/<name>/`. Das Installations-Manifest pro Plugin ist
`.mercury-plugin.json` im Verzeichnis jedes verwalteten Plugins. Das Laden und die Erkennung bleiben
unverändert — dieser Befehl installiert, aktualisiert, entfernt und listet nur die Dateien, die der Loader
ohnehin liest.
