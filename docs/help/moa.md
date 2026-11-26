# Mixture-of-Agents (`mercury moa`)

Send the **same** prompt to several **proposer** model slots in parallel, collect their proposals, and
produce one final answer. MoA is a natural extension of the Jev router and teams: a "model slot" is the
same `"<provider>/<model>"` id (or the router alias `"auto"`) the rest of Mercury uses, and every
proposer/aggregator call flows through the **same** LLM gateway (routing, RBAC, budgets, usage ledger).
MoA layers aggregation on top — it does not add a second LLM mechanism.

## Run a query — `mercury moa "<prompt>"`

```
mercury moa "What is the capital of France?"
mercury moa "Draft a release note for v2" --proposers openai/gpt-4o,anthropic/claude-sonnet-4-5 --aggregator openai/gpt-4o
mercury moa "Is this statement true?" --strategy vote --proposers auto,auto,auto
mercury moa "Summarize the design" --show-proposals --json
```

## Strategies

- **synthesize** (default) — an **aggregator** model slot reads every successful proposal and writes the
  single final answer. Prefer this when you want the best model to reconcile and merge the proposals.
- **vote** — majority / self-consistency: answers are grouped (case- and whitespace-insensitive) and the
  group with the most proposers wins; ties are broken by first appearance. **No aggregator call is
  made.** Repeat the same slot (e.g. `--proposers auto,auto,auto`) for self-consistency sampling.

## Flags

- `--proposers a,b,c` — comma-separated proposer model slots (`"<provider>/<model>"` or `"auto"`).
  Defaults to the `moa.proposers` config list, else the default model. The same slot may be repeated.
- `--aggregator <slot>` — aggregator model slot for `synthesize` (default: `moa.aggregator` config).
- `--strategy synthesize|vote` — aggregation strategy (default: `moa.strategy` config).
- `--system <text>` — optional system prompt prepended to every proposer call.
- `--show-proposals` — also print each proposer's answer (and any failures) before the final answer.
- `--json` — emit the full structured result: every proposal (with status), vote tallies, counts and the
  final answer.

## Configuration (`moa.*`)

```yaml
moa:
  proposers: []          # default proposer slots; empty → use the default model
  aggregator: auto       # default aggregator slot for synthesize
  strategy: synthesize   # default strategy: synthesize | vote
```

Flags always override the config.

## Graceful degradation

A proposer that errors is **captured, not fatal** — the run proceeds with whatever succeeded (mirroring
teams). The result reports `usedProposers` / `failedProposers`. If **every** proposer fails (or all
answers are empty), the command errors with a nonzero exit code, because there is nothing to aggregate.

## Note on real models

The aggregation, voting and fan-out logic is pure and fully unit-tested offline. When you run `mercury
moa` live, the proposer and aggregator calls hit **real** models through the normal LLM gateway and need
provider credentials — nothing is mocked at runtime.
