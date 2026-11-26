# Prompt size

`mercury prompt-size` estimates how large the assembled system prompt/context is, broken down by
component, in characters and an approximate token count.

## Usage

```
mercury prompt-size [--json]
```

## What it measures

The command measures the real, offline-available components of the system prompt the agent assembles:

- **system prompt (persona)** — the active personality's prompt.
- **instruction hierarchy** — the security/instruction-hierarchy block injected into every prompt.
- **skills/tools index** — the catalogue of skills/tools advertised to the model.
- **memory/context** — reported as `0` here (see the approximation note).

## Approximation

Token counts are a heuristic of roughly **4 characters per token** — not a real tokenizer — so treat them
as estimates. The session-dependent pieces (conversation memory, retrieved context, per-turn hints) only
exist during a live run, so they are reported as `0`. The total is therefore a **lower-bound estimate** of
the static base prompt, not an exact per-request figure.

## Output

A table of components with characters and approximate tokens, plus a `TOTAL` row. `--json` emits the full
report (`components`, `totalChars`, `totalTokens`, `approximate`).
