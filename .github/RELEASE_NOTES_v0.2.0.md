# Mercury Agent v0.2.0

Self-hosted, extensible agentic AI platform written entirely in TypeScript (Node.js >= 22.5).

This release focuses on **security auditing**: Mercury now records authentication and
authorization events consistently across both the HTTP API and the CLI, and exposes a
filtered, paginated, hash-chain-verifiable audit trail to administrators.

## Highlights

- **Auth/authz audit coverage.** Successful and failed logins (`auth.login` /
  `auth.login_failed`, with a reason: `unknown_user`, `bad_password`, `account_disabled`),
  API token issuance and revocation (`token.issue` / `token.revoke`), and gateway pairing
  approvals and rejections (`pairing.approve` / `pairing.reject`). Events are written at the
  service layer, so actions taken through the CLI are captured as well as those through HTTP.
  Attempted passwords are never stored.
- **Queryable audit trail.** `AuditLog.query({ actor, action, target, since, until, limit,
  offset })` with exact-or-dotted-prefix action matching (e.g. `token` matches `token.issue`
  and `token.revoke`). Exposed via admin-only `GET /api/audit?...` (with a `total` count) and a
  new `mercury audit [list|verify]` CLI command.
- **Service-layer user auditing.** `user.register` / `user.update` / `user.delete` are now
  audited at the service layer, closing a gap where admin user changes made through the CLI
  (`mercury user add|role|delete`) and the `POST /api/users` route were previously unaudited.
  Each entry is attributed to the operating principal; `user.update` records only changed fields.

## Quality gate

Verified from a clean build: `npm run build`, `npx eslint .` and `npm test` all pass.
The test suite grew to **90 offline tests across 9 files** (new `tests/audit.test.ts` plus an
admin `/api/audit` server test). CI and CodeQL workflows are green on this commit.

## Honesty note

All tests run offline against the in-suite mock provider (`MERCURY_ENABLE_MOCK=1`). No runtime
code path uses a mock. Nothing in this release has been exercised against real external services;
see `STATUS.md` for the full tested-vs-untested breakdown.

See `CHANGELOG.md` for the complete list of changes.
