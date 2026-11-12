# Observability & debugging

Every run records an event trace (LLM calls, tool calls, decisions, guardrails, subagents).

- Web → Runs: inspect traces and subagent trees; Web → Observability: live events, paused runs, audit log.
- Breakpoints: pause before tool calls / LLM calls (`/debug` or the Observability panel), then continue or abort.
- `mercury replay <runId>` prints a trace; `/metrics` exposes Prometheus metrics.
