# Mercury — Launch & Awareness Assets

This file collects copy-paste-ready text for announcing Mercury across different
channels. The tone is deliberately honest and early-stage: Mercury has a large
*implemented* surface area and a 69-test offline suite, but it has **not** yet been
exercised against real external LLM / chat / voice services. Keep that framing —
the HN and r/LocalLLaMA crowds reward candor and punish overclaiming.

Repo: https://github.com/ms1963/mercury_agent — MIT — © 2026 Michael Stal

---

## 1. GitHub "About" description + Topics

**About (short description, paste into the sidebar "About" ⚙️):**

> Self-hosted, extensible agentic AI platform in TypeScript — 16 chat gateways, 76 built-in tools, MCP client *and* server, multi-agent workflows, persistent memory, and an optional decision engine. Bring your own LLM.

**Topics (add these in the About settings):**

```
agentic-ai  ai-agent  llm  typescript  mcp  autonomous-agents  openrouter  ollama  chatbot  self-hosted
```

---

## 2. Show HN

**Title:**

```
Show HN: Mercury – a self-hosted agentic AI platform in TypeScript
```

**Body:**

> Mercury is a self-hosted agentic AI platform written in TypeScript. You bring
> your own LLM (OpenRouter, Ollama, LM Studio, any OpenAI-compatible endpoint, or
> Anthropic) and Mercury gives you the agent runtime around it: a CLI and a
> no-build web UI, 16 chat gateways (Telegram, Discord, Slack, WhatsApp, Signal,
> Matrix, Mattermost, Teams, IRC, Email, SMS, Home Assistant, RSS, webhook,
> webchat, CLI), 76 built-in tools plus polyglot custom tools, multi-agent YAML
> workflows, persistent memory (working/episodic/semantic/procedural), a scheduler
> that takes natural language or cron, and voice (STT/TTS).
>
> The thing I'm most happy with is that Mercury is both an MCP *client* and an MCP
> *server* — it can consume external MCP tools and expose its own tools/agents to
> other MCP clients. There's also an optional decision engine ("Jev") for model
> routing, risk judgment, triage, and reflection, and the usual self-hosting
> necessities: scrypt+JWT auth, RBAC, guardrails, a filesystem path jail, an SSRF
> guard, an audit log, event traces with replay, and a Prometheus /metrics
> endpoint.
>
> Honesty up front: this is v0.1.0 and early. There's an offline test suite (69
> tests) that runs against a mock provider, but I have **not** yet tested it
> against real LLM endpoints, real chat platforms, or real STT/TTS services at
> scale. So treat it as "a lot of implemented surface area, lightly battle-tested."
> I'd genuinely value feedback on the architecture and on what to harden first.
>
> Requires Node >= 22.5 (it uses the built-in node:sqlite). MIT licensed.
>
> Repo: https://github.com/ms1963/mercury_agent

---

## 3. Reddit — r/LocalLLaMA

**Title:**

```
I built Mercury: a self-hosted agentic platform (TypeScript) that runs on Ollama/LM Studio/OpenRouter — MCP client + server, 16 chat gateways, 76 tools
```

**Body:**

> I've been building **Mercury**, a self-hosted agentic AI platform in TypeScript,
> and it's designed around *your* local model rather than a hosted API. It talks to
> Ollama, LM Studio, any OpenAI-compatible server, OpenRouter, or Anthropic — no
> built-in model, you point it at whatever you already run.
>
> What's in it:
> - **16 chat gateways** — Telegram, Discord, Slack, WhatsApp, Signal, Matrix,
>   Mattermost, Teams, IRC, Email, SMS, Home Assistant, RSS, webhook, webchat, CLI
> - **76 built-in tools** + the ability to add polyglot custom tools
> - **MCP client *and* server** — consume external MCP tools, and expose Mercury's
>   own tools/agents to other MCP clients
> - **Multi-agent workflows** defined in YAML
> - **Persistent memory** — working / episodic / semantic / procedural, plus a
>   blackboard and a user model
> - **Scheduler** — natural language ("every weekday at 9am") or cron
> - **Voice** — STT/TTS
> - **Security for self-hosting** — scrypt+JWT, RBAC, guardrails, path jail, SSRF
>   guard, audit log
> - **Observability** — event traces + replay, Prometheus /metrics
> - An optional decision engine for model routing / risk / triage / reflection
>
> Runs on Node >= 22.5 (uses the built-in node:sqlite, so no native DB deps). CLI +
> a no-build web UI.
>
> **Being straight with you:** it's v0.1.0. There's a 69-test offline suite against
> a mock provider, but I haven't yet run it hard against real LLM backends or real
> chat platforms. So it's feature-rich but lightly tested in the wild — I'd love
> for people here to try it against their local setups and tell me where it breaks.
>
> MIT, repo here: https://github.com/ms1963/mercury_agent

**Note:** the same body works for **r/selfhosted** (lead with the self-hosting /
security / gateways angle) and **r/MachineLearning** (lead with the MCP
client+server and multi-agent workflow angle). Adjust the title accordingly and
keep the honesty paragraph in all of them.

---

## 4. X / Twitter thread

**1/**
> Launching Mercury 🪽 — a self-hosted agentic AI platform in TypeScript.
> Bring your own LLM (Ollama, LM Studio, OpenRouter, OpenAI-compatible, Anthropic).
> MIT. v0.1.0.
> https://github.com/ms1963/mercury_agent
> 🧵

**2/**
> It's both an MCP *client* and an MCP *server* — consume external MCP tools, and
> expose Mercury's own tools + agents to other MCP clients. That two-way bit is the
> part I'm proudest of.

**3/**
> 16 chat gateways out of the box: Telegram, Discord, Slack, WhatsApp, Signal,
> Matrix, Mattermost, Teams, IRC, Email, SMS, Home Assistant, RSS, webhook,
> webchat, CLI.

**4/**
> 76 built-in tools + polyglot custom tools, multi-agent YAML workflows, persistent
> memory (working/episodic/semantic/procedural), an NL+cron scheduler, and voice
> (STT/TTS).

**5/**
> Self-hosting basics are there: scrypt+JWT auth, RBAC, guardrails, filesystem path
> jail, SSRF guard, audit log, event traces with replay, Prometheus /metrics. Plus
> an optional decision engine for routing/risk/triage/reflection.

**6/**
> Honest status: it's early (v0.1.0). 69-test offline suite against a mock
> provider; not yet battle-tested against real LLM/chat/voice services. Lots of
> implemented surface, lightly tested in the wild. Feedback very welcome.
> Node ≥ 22.5. MIT.
> ⭐ https://github.com/ms1963/mercury_agent

---

## 5. LinkedIn post

> **Introducing Mercury — a self-hosted agentic AI platform in TypeScript.**
>
> Mercury gives you the agent runtime around your own LLM — Ollama, LM Studio,
> OpenRouter, any OpenAI-compatible endpoint, or Anthropic. Nothing is sent to a
> model you didn't choose.
>
> Highlights:
> • MCP client *and* server — interoperate both directions
> • 16 chat gateways (Telegram, Slack, Discord, WhatsApp, Teams, Matrix, and more)
> • 76 built-in tools + polyglot custom tools
> • Multi-agent YAML workflows, persistent memory, NL/cron scheduler, voice
> • Self-hosting security: scrypt+JWT, RBAC, guardrails, path jail, SSRF guard,
>   audit log
> • Observability: event traces, replay, Prometheus metrics
>
> It's an early release (v0.1.0): a lot of implemented capability, with a 69-test
> offline suite — not yet hardened against real external services at scale. I'd
> value feedback from anyone building self-hosted agents.
>
> MIT licensed: https://github.com/ms1963/mercury_agent
>
> #AI #AgenticAI #SelfHosted #TypeScript #LLM #MCP #OpenSource

---

## 6. Awesome-list PR entries

**awesome-ai-agents / awesome-llm (agents section):**

```
- [Mercury](https://github.com/ms1963/mercury_agent) - Self-hosted, extensible agentic AI platform in TypeScript. MCP client and server, 16 chat gateways, 76 built-in tools, multi-agent workflows, persistent memory, and an optional decision engine. Bring your own LLM (Ollama, LM Studio, OpenRouter, OpenAI-compatible, Anthropic). MIT.
```

**awesome-mcp-servers:**

```
- [Mercury](https://github.com/ms1963/mercury_agent) - Agentic AI platform that acts as both an MCP client and an MCP server, exposing its own tools and agents to other MCP clients while consuming external MCP tools. TypeScript, self-hosted, MIT.
```

**awesome-selfhosted (AI / Automation section):**

```
- [Mercury](https://github.com/ms1963/mercury_agent) - Self-hosted agentic AI platform in TypeScript with 16 chat gateways, 76 tools, multi-agent workflows, persistent memory, scheduler, voice, and self-hosting security (RBAC, guardrails, SSRF guard, audit log). Bring your own LLM. `MIT` `Nodejs`
```

> awesome-selfhosted requires a license tag and a language tag, and entries in
> alphabetical order within their section — place Mercury accordingly when you open
> the PR.

---

## 7. Suggested rollout order

1. Set the GitHub **About** text + **topics** first (so visitors landing from any
   link see a complete repo).
2. Post **Show HN** — pick a weekday morning US Eastern for best visibility; reply
   to early comments yourself.
3. Post to **r/LocalLLaMA** (then r/selfhosted and r/MachineLearning on following
   days, not all at once).
4. Publish the **X thread** and **LinkedIn** post; link back to the repo, not to
   any demo.
5. Open the **awesome-list PRs** once the About/topics are set and the README is
   final.

Keep every post honest about the tested-vs-untested status. Early adopters who hit
a rough edge after being told it's early will file issues; ones who were promised
"production-ready" will just leave.
