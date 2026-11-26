# Aktivitätsprotokolle

`mercury logs` zeigt die jüngste Mercury-Aktivität aus dem, was **bereits gespeichert** ist — der
`runs`-Tabelle, die eine Zeile pro Chat/Lauf aufzeichnet. Der Befehl ist nur lesend und führt keinen neuen
Protokollspeicher ein.

## Verwendung

```
mercury logs [--limit <n>] [--since <dur|ISO>] [--until <dur|ISO>] [--json]
```

- `mercury logs` — die 20 jüngsten Läufe als Tabelle.
- `mercury logs --limit 50` — die 50 jüngsten Läufe.
- `mercury logs --since 24h` — Aktivität der letzten 24 Stunden.
- `mercury logs --since 2026-01-01 --until 2026-02-01` — Aktivität im Januar.
- `mercury logs --json` — die Zeilen als JSON.

## Flags

- `--limit <n>` — höchstens `n` Zeilen anzeigen, neueste zuerst (Standard `20`).
- `--since <dur|ISO>` — nur Aktivität ab diesem Zeitpunkt: eine Dauer (`30d`, `12h`, `90m`, `2w`) oder ein
  ISO-Datum/-Zeitstempel.
- `--until <dur|ISO>` — nur Aktivität vor diesem Zeitpunkt (gleiche Formate).
- `--json` — gibt die Zeilen als JSON statt als Tabelle aus.

## Ausgabe

Jede Zeile zeigt Startzeit, Art (`chat`, `run`, ...), Status und eine einzeilige Zusammenfassung der
Eingabe (oder Ausgabe). Ein leeres Ergebnis gibt `no activity recorded` aus und beendet mit `0`.

## Hinweise

- Dies ist eine Momentaufnahme. Es gibt kein Live-`--follow`, da Läufe nach ihrem Ende gespeichert und
  nicht in eine Protokolldatei gestreamt werden.
