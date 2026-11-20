# Mercury security model

Mercury is an agent that can run shell commands, read files, browse the web and talk to chat
platforms. Treat it like a remote shell for whoever can log in. This document describes the
controls that exist and what they do and do **not** protect against.

## Authentication and authorization

- **Users**: passwords hashed with scrypt (`packages/core/src/auth/crypto.ts`). The **first
  registered user becomes admin**; later sign-ups are `user`. Disable open registration with
  `mercury config set auth.allowRegistration false`.
- **Sessions**: HS256 JWTs signed with a random key stored in `$MERCURY_HOME/secret.key`
  (created on first start; keep the data directory private). Default lifetime: 7 days.
- **API tokens**: `mrc_…` tokens, stored only as SHA-256 hashes, with optional expiry and scopes:
  `chat, agent, workflow, memory, skills, tools, schedule, mcp, admin, read, *`.
  Create with `mercury token create ci --scopes chat,mcp`.
- **RBAC**: admin-only permissions (users, config, gateway pairing, audit) are enforced per route.
  Each user's sessions, memory and runs are scoped to that user.
- **Per-agent/personality permission profiles** (`auth/policy.ts` `effectivePolicy()`): a declarative
  profile (under `<dataDir>/permissions/`) is merged with the base policy by **strict intersection** —
  deny-lists union, `maxToolRisk` takes the minimum, allow-lists are intersected. A profile can only
  **further-restrict**, never escalate, so binding a locked-down profile to a personality is safe even
  if the profile is attacker-supplied. See [PERMISSIONS.md](PERMISSIONS.md).
- **MCP endpoint** (`/mcp`): requires a bearer token with the `mcp` scope and, for every
  tool, the matching scope (`agent`, `workflow`, `memory`, `skills`, `schedule`). Built-in tools are
  exposed as `mercury_<name>` only with the `tools` scope.
- **Rate limiting**: per-client fixed window (`server.rateLimit`, default 300 requests / minute),
  backed by SQLite (`rate_limits` table) so counters persist across restarts and are shared across
  the process (single-host; not cross-replica).
- **Webhooks**: adapter webhooks verify platform signatures (e.g. HMAC-SHA256 for the generic
  webhook adapter, Slack signing secret). Requests that fail verification get a 401. Telegram
  uses long polling, so it needs no inbound webhook.

## Prompt-injection defence (layered)

Implemented in `packages/core/src/agent/guardrails.ts` and `packages/core/src/security/`.

1. **Input**: a heuristic scanner scores every inbound message for injection patterns
   (instruction overrides, fake system/role markers, role-play jailbreaks, exfiltration and
   tool-coercion requests, spotlight-marker forgery, encoded payloads).
   Content from untrusted sources (mail, webhooks, unpaired chat users, tool output) or text
   that scores as suspicious is also classified by the **decision engine** (Jev, LLM or mock).
   Scores above `decision.thresholds.injection` (default 0.7) are blocked.
2. **Context**: untrusted content is *spotlighted*, wrapped in delimiters with an explicit
   "data, not instructions" notice. The system prompt states the instruction hierarchy.
3. **Action**: when untrusted content is in context, *sensitive* tools (ones that write, send or
   execute) need approval. Approval mode is `tools.approvals.mode`: `manual` (default) | `smart`
   (the decision engine approves low-risk calls above `decision.thresholds.toolApproval`) | `auto` | `deny`.
4. **Output**: secrets (API keys, tokens, private keys) are redacted, PII can optionally be
   redacted, and a random **canary** in the system prompt detects prompt leaks.

These layers reduce risk; they cannot guarantee it. No LLM-based system is immune to prompt
injection. Keep approvals on `manual` when the agent reads untrusted content and can act on it.

## Governance: least-privilege grants, policy-as-code and taint tracking

Three governance layers sit in front of sensitive tool actions (all config-driven and
backward-compatible — new keys default to safe values).

- **Least-privilege per-task credential grants (no standing keys).** `GrantBroker`
  (`core/src/auth/grants.ts`) issues scoped, time-limited `Grant`s bound to a single task/run.
  A tool that declares a `capability` (and optional `capabilityScope`) is denied
  (`GrantDeniedError`) unless a live grant exists. Grants have a TTL (clamped to
  `security.grants.maxTtlMs`, default 1 h; default TTL `security.grants.defaultTtlMs`, 5 min) and
  optional use caps, and can be revoked individually or per task. Ephemeral credentials are
  **minted in memory against a grant and never persisted**, and vanish the instant the grant
  expires or is revoked. API: `GET/POST /api/grants`, `DELETE /api/grants/:id` (writes require
  `config.manage`; reads require `audit.read`).
- **Policy-as-code enforced before sensitive actions.** `PolicyCodeEngine`
  (`core/src/security/policy-code.ts`) evaluates declarative rules that yield `allow` / `deny` /
  `approve`; the **strictest effect wins** (deny > approve > allow; an explicit allow
  short-circuits). The tool executor blocks `deny` and forces an approval gate on `approve` —
  even in `auto` mode — before the action runs. A built-in rule set (enabled by
  `security.policies.builtins`) enforces a payment cap (`paymentApprovalThreshold`, `currency`,
  default €100) and an external-email rule (`allowedEmailDomains`); add your own under
  `security.policies.rules`. API: `GET /api/policies`, `POST /api/policies/test`.
- **Prompt-injection taint tracking of tool outputs.** `TaintTracker`
  (`core/src/security/taint.ts`) marks tool outputs that cross the trust boundary as *tainted*
  (scanning them with the existing injection scanner), propagates taint monotonically across a run,
  and maintains a value-level provenance graph. Policy rules can gate on taint (`whenTainted`) so a
  sensitive action driven by untrusted content is routed to approval or blocked.

## Tool sandboxing

- **Path jail** (`tools.jail.roots`): file tools are confined to the configured roots plus the
  workspace. `tools.jail.allowOutside: true` turns this off.
- **Dangerous commands**: shell commands are classified (`security/commands.ts`). `rm -rf /`, disk
  formatting, fork bombs, `curl | sh`, `sudo` and credential-file access are flagged
  `dangerous` and always need approval.
- **SSRF guard**: web tools use `safeFetch`, which resolves hosts and blocks private, loopback and
  link-local addresses unless `tools.web.allowPrivateNetworks` is true. It also caps response size.
- **Terminal backends**: `local` (default) runs as the Mercury OS user. For isolation use the
  `docker` backend (`tools.terminal.backend`), or run Mercury itself in Docker / under the hardened
  systemd unit in `deploy/mercury.service`.
- **Budgets**: per-user/model token and cost limits (`budgets.rules`) stop runaway loops.
- **Add-In loading** (`core/src/addins`): declarative add-ins discovered under `<dataDir>/addins/`
  are loaded by path — the loader rejects any entry whose resolved path escapes the add-ins root
  (`../` traversal), skips malformed manifests, and records a warning instead of failing. Loaded tools
  still pass through the same risk/approval gating as built-ins; a permission profile shipped by an
  add-in can only further-restrict (see above).

## Chat platforms (gateway)

- Unknown chat users get a **pairing code**. Nothing reaches the agent until an admin approves it
  (`mercury gateway pair <CODE>` or the web UI). Approving links the chat identity to a Mercury user.
- Messages from paired users run with that user's permissions. Gateway triage can send messages to
  human review when decision confidence is below `decision.thresholds.triageReview`.

## Audit and observability

- The **audit log** is hash-chained: each entry includes the hash of the previous one, so tampering
  is detectable (`verify()` in `security/audit.ts`; SQL triggers forbid UPDATE/DELETE). It records
  user registration, updates (role changes) and deletion (`user.register` / `user.update` /
  `user.delete`, recorded at the service layer so CLI admin actions are captured too), config changes,
  successful and failed logins
  (`auth.login` / `auth.login_failed`, the latter tagged with a reason of `unknown_user`,
  `bad_password` or `account_disabled` — the attempted password is never stored), API token issuance
  and revocation (`token.issue` / `token.revoke`), and gateway pairing approvals and rejections
  (`pairing.approve` / `pairing.reject`). These are recorded at the service layer, so they are
  captured whether the action arrives over the HTTP API or through the CLI. Guardrail verdicts
  additionally appear in run traces.
- The audit log is queryable: `AuditLog.query({ actor, action, target, since, until, limit, offset })`
  supports exact or dotted-prefix action matching (e.g. `token` matches `token.issue` and
  `token.revoke`) and returns a `total` count alongside the page. It is exposed over the admin-only
  `GET /api/audit?...` route and the `mercury audit [list|verify]` CLI command.
- Every run records an event trace (LLM calls, tool calls, decisions, guardrail verdicts),
  viewable in the debug panel or with `mercury replay <runId>`.
- **Replayable audit trail ("why did you do that?").** `buildTrace` (`core/src/events/replay.ts`)
  turns a run's recorded event stream into an ordered, human-readable trace — per-step explanations
  plus run-level totals (cost, tokens, LLM/tool/decision counts, taint, duration). Exposed over
  `GET /api/runs/:id/trace` and the **Governance** Web UI panel, which also manages grants and
  tests policies.

## Deployment checklist

- Put Mercury behind TLS (reverse proxy) when it is reachable from a network.
- Register the admin first, then disable registration.
- Keep `$MERCURY_HOME` (database, `secret.key`, attachments) readable only by the Mercury user.
- Prefer scoped, expiring API tokens over admin JWTs for integrations.
- Run under Docker or the provided systemd unit, not as root.
- Leave tool approvals on `manual` unless the agent only sees trusted input.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than in a public issue.
