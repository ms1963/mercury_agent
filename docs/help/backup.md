# Backup / restore

Full-home backup and restore for a Mercury instance. A backup is a complete, integrity-checked snapshot
of this instance's Mercury home (`~/.mercury` by default) written as a single gzipped-JSON `.mbak`
archive: config, the memory database (and its `-wal`/`-shm` sidecars), skills, add-ins, permission
profiles, plugins, wiki and bundles.

## Create a backup — `mercury backup`

- `mercury backup` — write a backup of the Mercury home to a timestamped `.mbak` file in the current directory.
- `mercury backup --out <file>` — write the archive to a specific path instead.
- `mercury backup --include-secrets` — also back up the secret files (`.env`, `audit.key`). Excluded by default.
- `mercury backup --json` — emit the manifest plus digest/signature as JSON.

## Inspect a backup — `mercury backup inspect <file>`

Verifies an archive and prints its metadata **without restoring anything**:

- content digest valid (tamper/corruption check),
- every per-file SHA-256 valid,
- signature `VALID` / `INVALID` / `absent` (`INVALID` usually means the archive came from a different
  instance, since it is signed with this instance's audit key),
- compatibility with this Mercury version,
- created-at, Mercury version, format version, file count, total bytes and whether secrets were included.

Add `--json` for the structured result.

## Restore a backup — `mercury import <file>`

`mercury import <file>` (alias: `mercury restore <file>`) restores an archive into the Mercury home.

- The restore **refuses to overwrite** existing files unless you pass `--force`.
- With `--force`, Mercury **first writes a pre-restore safety backup** of the current home (secrets
  included) next to the data directory, so the restore is reversible, and reports its path.
- Integrity is verified **before any file is written** — a corrupt or tampered archive is rejected and
  nothing is restored (the restore is all-or-nothing with respect to tamper detection).
- Add `--json` for `{ restored: [...], preRestoreBackup?: path }`.

Restart Mercury after a restore so it picks up the restored config and data.

## The `.mbak` format

A `.mbak` file is a gzipped JSON document with a `manifest` (metadata plus a per-file table of contents:
relative path, mode, byte length and SHA-256), a `files` map of `path -> base64(contents)`, a content
`digest` (SHA-256 of the canonical manifest+files) and an optional HMAC `signature` keyed by the
instance audit key. The builder sorts entries and file keys and gzip writes a zero mtime, so backups are
deterministic: identical inputs produce identical bytes.

## Secret-exclusion default

By default the two secret-bearing files (`.env`, `audit.key`) are **excluded**, so a backup is safe to
hand to a colleague or store off-box. Pass `--include-secrets` for a full disaster-recovery snapshot.
Volatile files (`*.log`, `*.mbak`, sockets, pids, temp files, `node_modules/`, `.git/`) and symlinks are
always excluded.

## A note on the live database

Backup works on a running server; the SQLite `-wal`/`-shm` sidecars are included so an online snapshot is
restorable. For a perfectly consistent database snapshot you may stop the server first, but it is not
required.
