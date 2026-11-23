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
- **MCP endpoint** (`/mcp`): requires a bearer token with the `mcp` scope (checked as the policy
  action `mcp.access`) and, for every
  tool, the matching scope (`agent`, `workflow`, `memory`, `skills`, `schedule`). Built-in tools are
  exposed as `mercury_<name>` only with the `tools` scope.
- **Rate limiting**: per-client fixed window (`server.rateLimit`, default 300 requests / minute),
  backed by SQLite (`rate_limits` table) so counters persist across restarts and are shared across
  the process (single-host; not cross-replica).
- **Webhooks**: adapter webhooks verify platform signatures (HMAC-SHA256 for the generic webhook
  adapter, `x-hub-signature-256` for WhatsApp/Facebook, Slack signing secret). Requests that fail
  verification get a 401. WhatsApp/Facebook **fail closed**: without `appSecret` every POST is
  refused with 401 unless the adapter sets `allowUnsigned: true` (local testing only). The webchat
  widget has no signature; its visitor id must be a random 16-128 character id and is the only
  secret for polling replies. Telegram uses long polling, so it needs no inbound webhook.
- **Accounts**: changing a password needs the current password and revokes all JWTs issued
  before the change (a fresh token is returned). Disabling a user, demoting them or changing their
  role revokes their JWTs; the last admin cannot be demoted, disabled or deleted. After 10 failed
  logins within 15 minutes an account is locked for 15 minutes (HTTP 429), independent of the
  per-IP rate limit. The first registered user becomes admin; this decision is made atomically in
  the INSERT.
- **API tokens** expire after at most `auth.apiTokenMaxTtlDays` (default 365, `0` = no limit) and
  cannot mint other tokens or change passwords. `?token=` query authentication is accepted only on
  the SSE endpoint `/api/events`.
- **Ownership**: run-scoped endpoints (`/api/runs/:id/*`, feedback, stop, replay, time-travel,
  events/trace, debug resume), approvals, team runs, task budgets, schedules and verification
  records are visible only to their owner and admins (other users get 404). Schedule names/tasks of
  the form `__name__` are reserved for internal jobs (non-admins get 403).
- **`/metrics`** is served to a direct loopback request (no `X-Forwarded-*` headers), a bearer equal
  to `observability.metricsToken`, or an admin token; everything else gets 401.
- **HTTP headers**: CSP, `X-Frame-Options`, `X-Content-Type-Options: nosniff` and, for `/api`,
  `/mcp`, `/metrics` and webhooks, `Cache-Control: no-store`. Uploaded attachments that are not
  inert media (HTML, SVG, ...) are served as `Content-Disposition: attachment`. 5xx responses carry
  a generic message; details go to the server log. Set `server.trustProxy` only behind a proxy you
  control.

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
- **Host execution** (`terminal`, `process_start`, `execute_code`) runs on the host and bypasses the
  path jail. For non-admin users every such call needs an **admin's** approval, in every approval
  mode including `auto` (`tools.hostAccess.nonAdmin`: `approve` (default), `deny`, or `allow` for the
  old behaviour). Commands run with a scrubbed environment (PATH/HOME/LANG...); provider keys and
  `MERCURY_*` secrets are not inherited unless listed in `tools.terminal.envPassthrough` (`'*'` =
  everything). On timeout or stop the whole process group is killed (docker: the container is
  removed). Mercury's data directory (database, `secret.key`, `audit.key`, config) is off-limits to
  file tools except the workspace inside it.
- **Command classification** (`security/commands.ts`) is a **heuristic denylist, not a sandbox**.
  `rm -rf /`, disk formatting, fork bombs, `curl | sh`, `sudo`, credential files, Mercury's own
  secrets and `/proc/*/environ` are `dangerous`; inline interpreter code (`python -c`, `sh -c`,
  `eval`), decoded payloads (`base64 -d`), environment dumps and `find -exec/-delete` are at least
  `moderate`. Obfuscated variants can still be rated `safe`, so use `approvals.mode: manual` or the
  docker backend when the model must not run arbitrary commands.
- **SSRF guard**: web tools use `safeFetch`, which resolves hosts and blocks all RFC 6890
  special-purpose ranges (private, loopback, link-local, CGNAT, benchmark, multicast, reserved) and
  IPv6 forms that embed IPv4 (`::ffff:`, NAT64 `64:ff9b::`, 6to4 `2002::`) unless
  `tools.web.allowPrivateNetworks` is true. The connection is pinned to the validated address (no
  DNS-rebinding window) and every redirect hop is re-validated. It also caps response size.
- **Terminal backends**: `local` (default) runs as the Mercury OS user. For isolation use the
  `docker` backend (`tools.terminal.backend`; containers run with `no-new-privileges`, pid/memory/CPU
  limits), or run Mercury itself in Docker / under the systemd unit in `deploy/mercury.service`
  (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, write access only to `~/.mercury` and
  the project dir). `execute_code` follows `tools.executeCode.backend`: `host` (child process, not a
  sandbox), `docker` (container with `--network none`, `--cap-drop ALL`, read-only root and code
  mount, user `nobody`, pid/memory/CPU limits; images `pythonImage`/`nodeImage`) or `auto` (default:
  docker when the terminal backend is docker). Tool calls from the script still go through the
  executor. Non-admin calls keep needing admin approval in both modes. Polyglot tools are
  admin-installed programs. `tools.polyglotBackend` decides where they run: `host`, `docker`
  (tool folder read-only at `/tool`, caller workdir at `/work` read-only unless tool.json sets
  `"workdir": "rw"`/`"none"`, no network unless `"network": true`, same container limits as
  `execute_code`; image from tool.json `"image"` or inferred for python/node commands, refused
  without one) or `auto` (default: docker when the terminal backend is docker and an image is
  known, otherwise host; `build` steps still run on the host). A polyglot tool whose folder lies inside a
  path-jail root (so the file tools could rewrite its code) is treated as host execution
  (`tools.hostAccess.nonAdmin` applies) and is pinned: its folder is fingerprinted at load and a
  call is refused once any file in it changed (restart Mercury to reload a reviewed change). Keep
  `tools.polyglotDirs` outside the jail roots for tools that should behave like ordinary tools.
- **Budgets**: per-user/model token and cost limits (`budgets.rules`) stop runaway loops. Auxiliary
  calls made as the system principal (wiki, team synthesis, critic, classifiers, MCP sampling)
  *inside a user's agent run or team run* are checked against and charged to that user's budget
  (the user's own and `*` rules). Approval-gate decisions (`kind: decision`) are exempt so a spent
  budget never disables the gate. Background auxiliary calls with no user context are charged to
  user `system`; add a rule with `user: system` to cap them (it also caps decisions).
- **Tool arguments**: tools with a zod schema are parsed by it (unknown keys stripped). Tools that
  only declare a JSON schema (custom/MCP tools) get required-key, top-level type/enum checks,
  `minimum`/`maximum`/`exclusive*`, `minLength`/`maxLength`, `maxItems`, and — when the schema says
  `additionalProperties: false` — rejection of undeclared keys. The same checks run again on
  arguments rewritten by a `before_tool_call` hook.
- **Tool timeouts**: on timeout/stop the tool's `AbortSignal` fires; built-in tools honour it. A
  custom tool that ignores it cannot be force-killed in-process: the execution is reported as
  `tool.runaway` (event + audit entry) and, while 2 such executions of the same tool are still
  running, further calls to it are refused until they finish.
- **Self-improvement**: automatic skill creation/refinement from reflections only happens for runs
  of admins; auto-derived failure playbooks quote a user's output and are shown only to that user.
  Proactive actions built from event text are marked as untrusted (tainted) and receive the event
  text spotlighted as data. Skill git installs accept only `https://`, `ssh://` and `git@` sources
  (no `ext::`/`file://`, no option injection, no submodules).
- **Add-In loading** (`core/src/addins`): declarative add-ins discovered under `<dataDir>/addins/`
  are loaded by path — the loader rejects any entry whose real path (symlinks resolved) escapes
  the add-in dir, skips malformed manifests, and records a warning instead of failing. Loaded tools
  still pass through the same risk/approval gating as built-ins; a permission profile shipped by an
  add-in can only further-restrict (see above).

## Chat platforms (gateway)

- Unknown chat users get a **pairing code**. Nothing reaches the agent until an admin approves it
  (`mercury gateway pair <CODE>` or the web UI; the API route requires `gateway.manage`). Approving
  links the chat identity to a Mercury user; an identity already linked to another user is only
  moved with an explicit `relink`.
- Messages from paired users run with that user's permissions. Gateway triage can send messages to
  human review when decision confidence is below `decision.thresholds.triageReview`.

## Audit and observability

- The **audit log** is hash-chained: each entry includes the hash of the previous one, so tampering
  is detectable (`verify()` in `security/audit.ts`; SQL triggers forbid UPDATE/DELETE). New entries
  are chained with HMAC-SHA256 under a key in `<dataDir>/audit.key` (or `MERCURY_AUDIT_KEY`), so
  someone who can write the database but not read the key cannot recompute a valid chain; once a
  keyed entry exists, later unkeyed entries fail verification. Keep `audit.key` (and back it up
  separately from the database) — without it existing keyed entries cannot be verified. It records
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

## Verification and escalation (human-in-the-loop safety net)

The verification subsystem (`core/src/verification`) checks that a task is actually done on
**evidence** rather than the model's say-so: `test` (a real shell command), `schema` (JSON-schema),
`assertion` (substring/regex/predicate) and `critic` (the decision engine as judge) each yield a 0..1
confidence, aggregated into one score. When the score is below `verification.confidenceThreshold` the
run is **escalated for human review** (persisted, reviewable at `GET /api/escalations` and resolvable
via `POST /api/escalations/:id/resolve`) instead of silently passing — a safety backstop against
over-confident completion of sensitive work. Checks are opt-in per step. With
`verification.autoVerify: true` every completed top-level agent run is additionally verified by a
required `critic` check (one extra judge call per run); failures are escalated. It is off by default.

## Chaos fault injection (operator-gated)

Reliability-engineering chaos (`core/src/reliability/chaos.ts`) can inject failures, timeouts and
latency into the **real** tool-execution path to prove graceful degradation. It is **off by default**
(`reliability.chaos.enabled = false`), deterministic (seedable) and gated by a tool-glob allowlist, so
it only ever perturbs tools you deliberately name — never enable it against production credentials or a
live gateway. Treat it as a staging/CI tool.

## Deployment checklist

- Put Mercury behind TLS (reverse proxy) when it is reachable from a network.
- Register the admin first, then disable registration.
- Keep `$MERCURY_HOME` (database, `secret.key`, attachments) readable only by the Mercury user.
- Prefer scoped, expiring API tokens over admin JWTs for integrations.
- Run under Docker or the provided systemd unit, not as root.
- Leave tool approvals on `manual` unless the agent only sees trusted input.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than in a public issue.
