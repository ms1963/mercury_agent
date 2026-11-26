# Session management

Manage the chat sessions that Mercury already persists in its memory database (`~/.mercury/mercury.db`).
`mercury sessions` is a **read/manage surface over existing data** — it lists, renames, exports, deletes
and prunes sessions, but never changes how sessions are written or the storage schema.

A *session* is a persisted conversation: an id, a title, created/updated timestamps, an optional model /
platform / personality, and its ordered messages. Sessions are created and appended to by `mercury chat`
and the server; this command only reads and manages them.

## List — `mercury sessions list`

Lists persisted sessions **most-recent-first** (by last-updated time) as a table: short id, updated time,
message count, title, and model / working directory when available.

- `mercury sessions list` — list all sessions.
- `mercury sessions list --limit <n>` — show at most `n`.
- `mercury sessions list --search <text>` — keep only sessions whose title contains `<text>` (case-insensitive).
- `mercury sessions list --json` — emit the sessions as JSON.

The ids in the table are shortened. You can pass the **short id (a unique prefix)** to any subcommand.

## Rename — `mercury sessions rename <id> <new-title>`

Sets or replaces a session's title.

- `mercury sessions rename 7f3a2b "Quarterly planning"`
- `--json` prints `{ id, title }`.

## Export — `mercury sessions export <id>`

Exports one session (metadata + all messages) to stdout or a file.

- `mercury sessions export <id>` — print a JSON document to stdout (pipe-friendly).
- `mercury sessions export <id> --format md` — print a markdown transcript instead.
- `mercury sessions export <id> --out <path>` — write to a file rather than stdout.
- With `--out`, add `--json` to print a `{ id, path, format, messages }` summary.

The JSON export is `{ formatVersion, session, messageCount, messages }`.

## Delete — `mercury sessions delete <id>`

Deletes one session and its messages. **Destructive, so it requires confirmation:**

- `mercury sessions delete <id> --force` (or `--yes`) — delete the session.
- Without `--force`/`--yes` the command refuses and exits non-zero (same gating as `mercury import --force`).
- `--json` prints `{ deleted, title }`.

## Prune — `mercury sessions prune`

Bulk cleanup. **Dry run by default** — it prints what *would* be deleted and deletes nothing until you
pass `--force`/`--yes`. Provide at least one selection criterion:

- `--older-than <dur|ISO>` — select sessions older than a duration (`30d`, `12h`, `90m`, `2w`, `45s`) or
  an ISO date/datetime (`2026-01-01`, `2026-01-01T12:00:00Z`).
- `--keep <n>` — protect the `n` most-recent sessions. With no other criterion, every session beyond the
  top `n` is selected.
- `--empty` — select sessions that have zero messages.

Criteria combine as a union (a session is selected if it matches *any* active criterion), except that
`--keep <n>` always **protects** the most-recent `n` from deletion. Examples:

- `mercury sessions prune --older-than 30d` — preview sessions not touched in 30 days.
- `mercury sessions prune --older-than 30d --keep 20 --force` — delete sessions older than 30 days, but
  always keep the 20 most recent.
- `mercury sessions prune --empty --force` — delete empty sessions.
- `--json` emits `{ dryRun, criteria, wouldDelete, deleted, keptCount }`.

## Exit codes

`0` on success. A not-found or ambiguous session id (and other errors) exits non-zero, consistent with
the rest of the CLI.

## Storage

Sessions live in the `sessions` table of the SQLite memory DB, with messages in `messages`
(`ON DELETE CASCADE`). This command operates entirely on that existing data — deletes go through the same
store used by the rest of Mercury (removing the session and cascading its messages, plus its full-text
search rows).
