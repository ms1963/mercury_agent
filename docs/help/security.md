# Security

- Passwords are hashed with scrypt; sessions use signed JWTs; API tokens (`mrc_…`) are stored hashed and carry scopes.
- Role-based access control (`admin`, `user`) plus per-user policy overrides.
- Dangerous tools need approval; shell commands are checked against a deny list; file tools are confined to the workspace.
- Tool output from the web/files is marked untrusted; guardrails detect prompt-injection patterns and block risky follow-up actions.
- Secrets are redacted from logs and the settings API; the audit log is hash-chained.

## Supply-chain audit — `mercury security audit`

Scans your dependencies for known vulnerabilities via the free [OSV.dev](https://osv.dev) API (no API key):

- `mercury security audit` — human-readable report grouped by source (npm / mcp / plugin).
- `mercury security audit --json` — full machine-readable report.
- Narrowing flags (default = all sources): `--npm`, `--mcp`, `--plugins`.
- `--lockfile <path>` — override the npm lockfile location (default: repo `package-lock.json`).
- Exit codes (CI-usable): `0` clean, `1` vulnerabilities found, `2` could not complete (e.g. OSV unreachable).

Sources audited: npm packages from `package-lock.json`, npm packages behind configured MCP servers, and
installed plugins plus their npm dependencies. Each finding shows the CVE/advisory id, severity and
fixed-in version when OSV provides them, a short summary, and the source it came from.

See docs/SECURITY.md in the repository for the full model.
