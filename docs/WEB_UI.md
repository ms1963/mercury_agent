# Working with the Web UI (instead of the CLI)

Mercury can be driven almost entirely from a browser. The web UI and the HTTP
API are served by the **same** process, so once the server is running, nearly
every CLI command has an equivalent panel in the UI. This guide explains how to
start the UI, sign in, and which panel replaces which command.

> The only steps that remain at the terminal are the one‑time `serve` (and,
> optionally, `setup`) and — if you prefer the command line — LLM provider
> configuration, which also has a UI panel.

---

## 1. Start the server

```bash
# From a built checkout:
node packages/cli/dist/bin.js serve            # web UI + API on http://localhost:3000

# Or, if you installed the global binary (./install.sh):
mercury serve                                  # add --port 3000 or --host 0.0.0.0

# Or with Docker:
docker compose up -d                           # data persists in the mercury-data volume
```

`serve` starts the HTTP API, the static web UI, the scheduler, the chat
gateways and the MCP endpoint together. Then open:

```
http://localhost:3000
```

---

## 2. Register and sign in

The landing screen is a login card.

1. Click **Register**.
2. Create the first account. **The first account that registers becomes the
   admin.**
3. You are now signed in. Your browser session authenticates you — there is no
   separate token step for using the UI itself. (API tokens are only needed for
   scripts and gateways; you mint those later in the **Account** panel.)

Before the agent can actually answer, **one LLM provider must be configured**
(see §4). Until then, Chat will connect but has no model to call.

---

## 3. The layout

After login you get:

- A left **navigation** rail. It is a hash router, so every panel is also a
  bookmarkable URL — `#chat`, `#memory`, `#users`, and so on.
- The main **view**, which renders the selected panel.
- Top‑right controls: a **language** selector (English / German), a **theme**
  toggle (dark / light, the `◐` button), and **Log out**.

Admin‑only panels (for example **Users**) appear in the nav only when you are
signed in as an admin.

---

## 4. Configure an LLM provider

You need exactly one provider enabled before Chat will respond.

- **In the UI:** open the **Models** panel to view and route against configured
  models and budgets.
- **At the CLI (one line):**

  ```bash
  # Local, no API key — run Ollama or LM Studio first, then:
  mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
  ```

See [docs/PROVIDERS.md](PROVIDERS.md) for the full list of providers.

---

## 5. Panel reference — and the CLI command each one replaces

| Panel (nav)       | What you do there                                                                                                                              | CLI equivalent                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Chat**          | Talk to the agent with live streaming, tool‑call chips and approvals, attachments, a microphone button, per‑message feedback, and model / pattern / personality pickers | `mercury chat`                     |
| **Sessions**      | Browse and search past conversations; **Continue** reopens one in Chat                                                                         | chat history                       |
| **Runs**          | Inspect agent and sub‑agent runs — the reason‑and‑act trace                                                                                    | (UI only)                          |
| **Workflows**     | View and launch multi‑agent workflows                                                                                                          | workflow commands                  |
| **Memory**        | Read and edit agent notes and user notes; search memory                                                                                        | memory commands                    |
| **Skills**        | List and manage installed skills                                                                                                               | `mercury skills`                   |
| **Tools**         | Browse the built‑in tools and add / remove MCP servers                                                                                         | `mercury tools`, `mercury mcp`     |
| **Scheduler**     | Create and inspect scheduled tasks                                                                                                             | `mercury schedule`                 |
| **Integrations**  | Chat‑gateway pairing; admins get a review queue to respond to or dismiss messages                                                              | `mercury gateway`                  |
| **Models**        | Route a task to a model; view model, router and budget configuration                                                                           | `mercury config` (`llm.*`)         |
| **Users** (admin) | Add users, change roles, delete users — every action is audited                                                                                | `mercury user add \| role \| delete` |
| **Debug**         | Live run / event stream and diagnostics                                                                                                        | `mercury doctor`                   |
| **Reflections**   | View the agent's self‑reflections                                                                                                              | (UI only)                          |
| **Help**          | Built‑in help topics                                                                                                                           | `mercury help`                     |
| **Account**       | Change your own account; **issue scoped API tokens**                                                                                           | `mercury token`                    |

---

## 6. Issuing API tokens (Account panel)

API tokens are created in **Account**, not in Users.

1. Open the **Account** panel.
2. Under **New token**, give the token a name and tick the **scopes** you want
   (for example `chat`).
3. Generate it, then copy the value — it is shown once.

This is the UI equivalent of `mercury token`. Existing tokens are listed with
their scopes, creation and expiry times, and an active / revoked badge; the `×`
button revokes one.

You can also change your own password from the Account panel.

---

## 7. Auditing (admin)

Every privileged action you take in the UI — logins, token issue and revoke,
pairing approvals and rejections, and user add / role / delete — is written to
the audit log and attributed to you. Administrators can read it through the
`GET /api/audit` endpoint (filterable by actor, action, target and time window),
the same trail exposed by the `mercury audit list | verify` command.

---

## 8. Notes and limits

- The UI is a no‑build single‑page app that talks to the REST API over HTTP and
  Server‑Sent Events. That is what powers streaming replies, live tool chips and
  the Debug event feed.
- The microphone feature needs browser mic access, which browsers grant only
  over HTTPS or on `localhost`.
- Everything done in the UI is subject to the same authentication, policy /
  permission checks and rate limiting the API enforces. If you expose the server
  beyond `localhost`, run it behind TLS and keep those protections in place.
