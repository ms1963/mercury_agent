# Datenbank-Migrationen

`mercury migrate` meldet oder wendet Datenbank-Migrationen an. Es **verwendet den vorhandenen
Migrationsrunner** und die rein anhängende Migrationsliste wieder — es fügt keine neuen Migrationen hinzu.

## Verwendung

```
mercury migrate [status] [--json]   # angewandte vs. ausstehende Migrationen zeigen (Standard)
mercury migrate up [--json]         # ausstehende Migrationen anwenden
```

## Unterbefehle

- `status` (Standard) — gibt aus, wie viele Migrationen angewandt bzw. ausstehend sind, die aktuelle
  Schema-Version und die Liste etwaiger ausstehender Versionen.
- `up` — wendet ausstehende Migrationen mit demselben Runner und der `schema_migrations`-Buchführung an.

## Hinweise

- Die Datenbank führt ihre Migrationen **beim Start von Mercury automatisch** aus, sodass im Normalbetrieb
  nichts aussteht und `migrate up` lediglich bestätigt, dass das Schema aktuell ist.
- `--json` gibt einen strukturierten Bericht aus (`total`, `current`, `applied`, `pending`, `upToDate`).
