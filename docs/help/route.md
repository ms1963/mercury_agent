# Criteria-based model routing

`mercury route` manages a list of **`provider/model` entries, each tagged with the criteria it serves**.
For every task, chat or workflow call, Mercury picks the **most specific entry whose criteria are all
satisfied** by the request and uses that model. It is a declarative way to say "send code to this model,
cheap small-talk to that one, private work to a local model".

Routing is stored in the config file under `llm.routing:`. The selected model is handed to the router as
the explicit model, so it still goes through RBAC **and** still benefits from the automatic fallback
chain (`mercury fallback`) if it turns out to be unavailable.

## Criteria vocabulary

Criteria reuse the existing **profile tag vocabulary**:

`general`, `code`, `reasoning`, `fast`, `cheap`, `vision`, `local`, `private`

A request carries tags it was given explicitly plus tags inferred from its content. An entry matches
**only when every one of its criteria is present** on the request (AND semantics); when several entries
match, the one with the **most criteria wins**. An entry with **no criteria, or exactly `default`**, is
the general-purpose **catch-all** used when nothing more specific matches.

## Usage

```
mercury route list [--json]
mercury route add <provider> <model> [criteria...]
mercury route remove <provider> <model> --force
mercury route clear --force
```

- `list` — show the routing chain, each entry with its criteria (or `default (catch-all)`). `--json` for raw.
- `add <provider> <model> [criteria...]` — add or replace an entry for that pair with the given criteria.
- `remove <provider> <model>` — delete a matching entry; requires `--force`.
- `clear` — remove the whole routing chain; requires `--force`.

## Configuration (`~/.mercury/config.yaml`)

```yaml
llm:
  defaultModel: openai/gpt-4o-mini
  routing:
    - { provider: anthropic, model: claude-sonnet-4-5, criteria: [code, reasoning] }
    - { provider: openai, model: gpt-4o-mini, criteria: [fast, cheap] }
    - { provider: ollama, model: llama3.1, criteria: [private, local] }
    - { provider: chatllm, model: route-llm, criteria: [default] }   # catch-all
```

## Example

```
mercury route add anthropic claude-sonnet-4-5 code reasoning
mercury route add openai gpt-4o-mini fast cheap
mercury route add chatllm route-llm default
mercury route list
```
