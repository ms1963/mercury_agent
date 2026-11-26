# Sitzungsverwaltung

Verwaltet die Chat-Sitzungen, die Mercury bereits in seiner Speicherdatenbank (`~/.mercury/mercury.db`)
persistiert. `mercury sessions` ist eine **Lese-/Verwaltungsoberfläche über vorhandene Daten** — sie
listet, benennt um, exportiert, löscht und bereinigt Sitzungen, ändert aber niemals, wie Sitzungen
geschrieben werden, oder das Speicherschema.

Eine *Sitzung* ist eine persistierte Unterhaltung: eine id, ein Titel, Erstellungs-/Aktualisierungs-
Zeitstempel, optional ein Modell / eine Plattform / eine Persönlichkeit sowie ihre geordneten
Nachrichten. Sitzungen werden von `mercury chat` und dem Server erstellt und ergänzt; dieser Befehl
liest und verwaltet sie nur.

## Auflisten — `mercury sessions list`

Listet persistierte Sitzungen **mit der neuesten zuerst** (nach letzter Aktualisierung) als Tabelle:
Kurz-id, Aktualisierungszeit, Nachrichtenanzahl, Titel sowie Modell / Arbeitsverzeichnis, falls
vorhanden.

- `mercury sessions list` — alle Sitzungen auflisten.
- `mercury sessions list --limit <n>` — höchstens `n` anzeigen.
- `mercury sessions list --search <text>` — nur Sitzungen, deren Titel `<text>` enthält (ohne Groß-/Kleinschreibung).
- `mercury sessions list --json` — die Sitzungen als JSON ausgeben.

Die ids in der Tabelle sind gekürzt. Sie können die **Kurz-id (ein eindeutiges Präfix)** an jeden
Unterbefehl übergeben.

## Umbenennen — `mercury sessions rename <id> <neuer-titel>`

Setzt oder ersetzt den Titel einer Sitzung.

- `mercury sessions rename 7f3a2b "Quartalsplanung"`
- `--json` gibt `{ id, title }` aus.

## Exportieren — `mercury sessions export <id>`

Exportiert eine Sitzung (Metadaten + alle Nachrichten) nach stdout oder in eine Datei.

- `mercury sessions export <id>` — ein JSON-Dokument nach stdout ausgeben (pipe-freundlich).
- `mercury sessions export <id> --format md` — stattdessen ein Markdown-Transkript ausgeben.
- `mercury sessions export <id> --out <pfad>` — in eine Datei statt nach stdout schreiben.
- Mit `--out` zusätzlich `--json` für eine Zusammenfassung `{ id, path, format, messages }`.

Der JSON-Export ist `{ formatVersion, session, messageCount, messages }`.

## Löschen — `mercury sessions delete <id>`

Löscht eine Sitzung und ihre Nachrichten. **Destruktiv, daher ist eine Bestätigung erforderlich:**

- `mercury sessions delete <id> --force` (oder `--yes`) — die Sitzung löschen.
- Ohne `--force`/`--yes` verweigert der Befehl und beendet sich mit einem Exit-Code ungleich null (gleiche
  Absicherung wie bei `mercury import --force`).
- `--json` gibt `{ deleted, title }` aus.

## Bereinigen — `mercury sessions prune`

Massenbereinigung. **Standardmäßig ein Probelauf (dry run)** — es wird ausgegeben, was gelöscht *würde*,
und nichts gelöscht, bis `--force`/`--yes` übergeben wird. Geben Sie mindestens ein Auswahlkriterium an:

- `--older-than <dauer|ISO>` — Sitzungen auswählen, die älter sind als eine Dauer (`30d`, `12h`, `90m`,
  `2w`, `45s`) oder ein ISO-Datum/-Zeitpunkt (`2026-01-01`, `2026-01-01T12:00:00Z`).
- `--keep <n>` — die `n` neuesten Sitzungen schützen. Ohne weiteres Kriterium wird jede Sitzung jenseits
  der obersten `n` ausgewählt.
- `--empty` — Sitzungen auswählen, die keine Nachrichten haben.

Kriterien werden als Vereinigung kombiniert (eine Sitzung wird ausgewählt, wenn sie *irgendein* aktives
Kriterium erfüllt), außer dass `--keep <n>` die neuesten `n` stets vor dem Löschen **schützt**. Beispiele:

- `mercury sessions prune --older-than 30d` — Vorschau von Sitzungen, die seit 30 Tagen nicht berührt wurden.
- `mercury sessions prune --older-than 30d --keep 20 --force` — Sitzungen löschen, die älter als 30 Tage
  sind, aber stets die 20 neuesten behalten.
- `mercury sessions prune --empty --force` — leere Sitzungen löschen.
- `--json` gibt `{ dryRun, criteria, wouldDelete, deleted, keptCount }` aus.

## Exit-Codes

`0` bei Erfolg. Eine nicht gefundene oder mehrdeutige Sitzungs-id (und andere Fehler) beenden sich mit
einem Exit-Code ungleich null, konsistent mit dem Rest der CLI.

## Speicherung

Sitzungen befinden sich in der Tabelle `sessions` der SQLite-Speicherdatenbank, Nachrichten in `messages`
(`ON DELETE CASCADE`). Dieser Befehl arbeitet ausschließlich auf diesen vorhandenen Daten — Löschungen
laufen über denselben Speicher, den der Rest von Mercury verwendet (die Sitzung wird entfernt und ihre
Nachrichten kaskadierend, zusammen mit ihren Volltextsuch-Zeilen).
