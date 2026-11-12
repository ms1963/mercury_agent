# LLM Providers

Mercury has **no built-in model**. You must point it at one real LLM backend before it can
answer. Any of the following work, local or remote — pick one (or configure several and let the
model router choose).

Model ids are always `"<provider>/<model>"`. Set the active one with `mercury model <id>`, the
`llm.defaultModel` config key, or `/model` in chat / the web UI. Leaving `llm.defaultModel: auto`
lets the router pick among every configured provider.

API keys go in `~/.mercury/.env` (see [`.env.example`](../.env.example)) or the process
environment — never in the config file. Provider wiring goes in `~/.mercury/config.yaml` (see
[`mercury.example.yaml`](../mercury.example.yaml)).

---

## OpenRouter (remote, hundreds of models)

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' >> ~/.mercury/.env
mercury model openrouter/openai/gpt-4o-mini      # or openrouter/anthropic/claude-3.5-sonnet, etc.
```

Setting `OPENROUTER_API_KEY` also enables the **optional** Jev decision model. OpenRouter is
auto-enabled whenever the key is present — no config entry required.

## Ollama (local, no API key)

Install and run [Ollama](https://ollama.com), pull a model, then:

```bash
ollama pull llama3.1
mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
mercury model ollama/llama3.1
```

Default base URL `http://localhost:11434/v1`; override with the `baseUrl` field if remote.

## LM Studio (local, no API key)

Start the LM Studio local server (default `http://localhost:1234/v1`), load a model, then:

```bash
mercury config set llm.providers.lmstudio '{"type":"lmstudio","enabled":true}'
mercury model lmstudio/<model-name-shown-in-lmstudio>
```

## Any OpenAI-compatible API (vLLM, LocalAI, Together, Groq, Azure OpenAI, …)

```bash
mercury config set llm.providers.myapi '{"type":"openai-compatible","baseUrl":"https://host/v1","apiKeyEnv":"MYAPI_KEY","enabled":true}'
echo 'MYAPI_KEY=...' >> ~/.mercury/.env        # omit if the endpoint needs no key
mercury model myapi/<model>
```

`apiKeyEnv` names the environment variable that holds the key; `headers` can add any extra
headers the endpoint needs.

## Anthropic (remote)

Uses Anthropic's native Messages API (not the OpenAI shape).

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.mercury/.env
mercury model anthropic/claude-sonnet-4-5       # or anthropic/claude-haiku-4-5
```

An Anthropic-**compatible** gateway (same API, different host) works via the `baseUrl` field:

```bash
mercury config set llm.providers.anthropic '{"type":"anthropic","baseUrl":"https://your-gateway","enabled":true}'
```

---

## The optional Jev decision engine

Jev is Michael Stal's typed decision/judgment model, used by Mercury for model routing,
injection classification, smart tool-approval, gateway triage, retry and reflection decisions.
It is **entirely optional**:

- `decision.provider: auto` (default) — use Jev **only** when `OPENROUTER_API_KEY` is set;
  otherwise use your configured LLM; otherwise fall back to a safe built-in heuristic.
- `decision.provider: jev` — force Jev (requires the OpenRouter key).
- `decision.provider: llm` — use your normal LLM for decisions, never Jev.
- `decision.provider: mock` — deterministic heuristic only (no network; used in tests).

Mercury runs fully without Jev — every decision degrades to the configured LLM or the heuristic.

## Testing / offline development

The deterministic mock provider is disabled in normal operation. Enable it only for offline
development or the test suite:

```bash
MERCURY_ENABLE_MOCK=1 mercury chat "hello"
```
