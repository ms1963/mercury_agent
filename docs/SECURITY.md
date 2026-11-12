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
- **MCP endpoint** (`/mcp`): requires a bearer token with the `mcp` scope and, for every
  tool, the matching scope (`agent`, `workflow`, `memory`, `skills`, `schedule`). Built-in tools are
  exposed as `mercury_<name>` only with the `tools` scope.
- **Rate limiting**: per-client fixed window (`server.rateLimit`, default 300 requests / minute).
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

## Chat platforms (gateway)

- Unknown chat users get a **pairing code**. Nothing reaches the agent until an admin approves it
  (`mercury gateway pair <CODE>` or the web UI). Approving links the chat identity to a Mercury user.
- Messages from paired users run with that user's permissions. Gateway triage can send messages to
  human review when decision confidence is below `decision.thresholds.triageReview`.

## Audit and observability

- The **audit log** is hash-chained: each entry includes the hash of the previous one, so tampering
  is detectable (`verify()` in `security/audit.ts`; SQL triggers forbid UPDATE/DELETE). It currently
  records user registration, user updates (role changes) and config changes. Logins, token changes
  and approvals are not audited yet, though guardrail verdicts do appear in run traces.
- Every run records an event trace (LLM calls, tool calls, decisions, guardrail verdicts),
  viewable in the debug panel or with `mercury replay <runId>`.

## Deployment checklist

- Put Mercury behind TLS (reverse proxy) when it is reachable from a network.
- Register the admin first, then disable registration.
- Keep `$MERCURY_HOME` (database, `secret.key`, attachments) readable only by the Mercury user.
- Prefer scoped, expiring API tokens over admin JWTs for integrations.
- Run under Docker or the provided systemd unit, not as root.
- Leave tool approvals on `manual` unless the agent only sees trusted input.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than in a public issue.
