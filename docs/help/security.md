# Security

- Passwords are hashed with scrypt; sessions use signed JWTs; API tokens (`mrc_…`) are stored hashed and carry scopes.
- Role-based access control (`admin`, `user`) plus per-user policy overrides.
- Dangerous tools need approval; shell commands are checked against a deny list; file tools are confined to the workspace.
- Tool output from the web/files is marked untrusted; guardrails detect prompt-injection patterns and block risky follow-up actions.
- Secrets are redacted from logs and the settings API; the audit log is hash-chained.
See docs/SECURITY.md in the repository for the full model.
