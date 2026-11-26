# Database migrations

`mercury migrate` reports or applies database migrations. It **reuses the existing migration runner** and
the append-only migration list — it adds no new migrations.

## Usage

```
mercury migrate [status] [--json]   # show applied vs pending migrations (default)
mercury migrate up [--json]         # apply any pending migrations
```

## Subcommands

- `status` (default) — print how many migrations are applied vs pending, the current schema version, and
  the list of any pending versions.
- `up` — apply any pending migrations using the same runner and `schema_migrations` bookkeeping.

## Notes

- The database runs its migrations **automatically when Mercury starts**, so in normal operation nothing
  is pending and `migrate up` simply confirms the schema is current.
- `--json` emits a structured report (`total`, `current`, `applied`, `pending`, `upToDate`).
