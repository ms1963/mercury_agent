# Operator-Konsole

`mercury console` startet die interaktive Chat-REPL mit einem Operator-Banner. Es ist ein komfortabler
Einstiegspunkt — gleichwertig zu `mercury chat` plus einem Banner, das die laufende Instanz zusammenfasst.

## Verwendung

```
mercury console [--user <name>] [--model <id>] [--session <id>] [--pattern <name>]
```

## Das Banner

Bevor die Eingabeaufforderung erscheint, gibt die Konsole aus:

- die Mercury-CLI-**Version**,
- den handelnden **Benutzer**,
- das **Datenverzeichnis**,
- den **Datenbankpfad**,
- eine **Konfigurationszusammenfassung** (Standardmodell, Persönlichkeit und ggf. Muster).

## Hinweise

- Alle REPL-Slash-Befehle sind verfügbar (`/help`, `/model`, `/usage`, `/reset`, ...).
- Die Flags entsprechen `mercury chat`. Mit `Ctrl-D` beendest du die Sitzung.
