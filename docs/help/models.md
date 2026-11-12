# Models, router & budgets

Model ids are `provider/model` (e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4`,
`ollama/llama3.1`, `mock/echo`). Providers activate when their API key is set.

- **Router**: picks a model per task based on difficulty (Jev judgment or heuristics) and the tiers in `router`.
- **Budgets**: daily/monthly cost and token limits per user or globally (`budgets.manage`). Over budget → fallback model or refusal.
- **Jev** (`typesafe/jev-1.13` via OpenRouter): the decision model used for routing, injection checks, approvals, gateway triage and reflection. Active when `OPENROUTER_API_KEY` is set (`decision.provider: auto`); otherwise Mercury falls back to the configured LLM, then to a mock judge.
