# Automatic fallback chain

`mercury fallback` manages an **ordered list of `provider/model` pairs** that Mercury tries, in order,
whenever the primary model is **unavailable**. It keeps the agent answering when one backend is down,
misconfigured, or rate-limited — without changing your default model.

The chain is stored in the config file under `llm.fallback:` and is appended **after** the router's own
candidates, so criteria-based routing (`mercury route`) and the fallback chain compose: the router (or a
`route` entry) picks the model, and if that model is unavailable the fallback chain takes over.

## What counts as "unavailable"

A single, centralized classifier decides when to advance to the next entry. It **falls back** on:

- model-not-found / unknown model / unknown provider / misconfiguration (404 and config errors)
- bad or missing API key (401 / 403, or the provider's env key is absent)
- connection refused / network error (e.g. a local backend such as Ollama is not running)
- rate-limit / overload (429 / 503 / 529 and other transient 5xx)
- an open circuit breaker for the model

It deliberately does **not** fall back on request-intrinsic failures, which would simply recur on any
model and so propagate to the caller:

- context-length / prompt-too-large
- bad request / malformed input (400 / 422)
- content-policy / safety refusals

## Usage

```
mercury fallback list [--json]
mercury fallback add <provider> <model> [--base-url <url>]
mercury fallback remove <provider> <model> --force
mercury fallback clear --force
```

- `list` — show the configured chain in order. `--json` for raw.
- `add <provider> <model>` — append a pair (deduplicated; order preserved). `--base-url` records an
  optional endpoint hint on the entry.
- `remove <provider> <model>` — delete a matching entry; requires `--force`.
- `clear` — remove the whole chain; requires `--force`.

## Configuration (`~/.mercury/config.yaml`)

```yaml
llm:
  defaultModel: openai/gpt-4o-mini
  fallback:
    - { provider: anthropic, model: claude-haiku-4-5 }
    - { provider: openai, model: gpt-4o-mini }
    - { provider: ollama, model: llama3.1 }        # last resort: local, always available
```

The referenced provider must be configured (`llm.providers` / an env key) for the id to resolve. The
`baseUrl` field is persisted for forward-compatibility; a per-entry base-URL override is not yet applied
during provider construction.

## Example

```
mercury fallback add anthropic claude-haiku-4-5
mercury fallback add ollama llama3.1
mercury fallback list
```
