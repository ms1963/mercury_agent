# Example `.env` files for Mercury LLM providers

Each file in this folder is a ready-to-use environment file for one LLM provider. Pick the one
for the provider you want, copy it to `~/.mercury/.env`, paste in your real API key, and run
Mercury — nothing else to edit.

```bash
# Example: use OpenAI
cp examples/env/openai.env ~/.mercury/.env
$EDITOR ~/.mercury/.env          # put your real key in
mercury chat "hello"             # Mercury reads ~/.mercury/.env automatically
```

> Mercury loads `~/.mercury/.env` on startup (see `MERCURY_HOME` to change the location).
> You can also just `export` these variables in your shell instead of using the file.

## How these files work

Mercury needs **at least one** LLM provider configured. Every file sets three kinds of things:

| Variable | Purpose |
| --- | --- |
| `MERCURY_MODEL` | The default model, written as `provider/model`. |
| `<PROVIDER>_API_KEY` | Your secret key for that provider. |
| `MERCURY__llm__providers__<id>=...` | (Only for non-built-in providers) registers the provider inline, as JSON. |

Four providers are **built in** and auto-enable the moment their key is present, so their files
only need the key plus `MERCURY_MODEL`: **OpenAI, Anthropic, OpenRouter, Abacus ChatLLM**.

Everything else (Groq, Mistral, DeepSeek, Together, Fireworks, Perplexity, xAI/Grok, Google
Gemini, Azure OpenAI, and the two local runners Ollama & LM Studio) is wired up through a single
generic `MERCURY__llm__providers__<id>={...}` line — that is just the same provider block you
would otherwise put in `config.yaml`, expressed as one environment variable. You never have to
touch a config file.

## Files

| File | Provider | Key needed? | Notes |
| --- | --- | --- | --- |
| `openai.env` | OpenAI | yes | built-in |
| `anthropic.env` | Anthropic (Claude) | yes | built-in |
| `openrouter.env` | OpenRouter | yes | built-in; also powers the optional Jev decision model |
| `chatllm-abacus.env` | Abacus.AI ChatLLM / RouteLLM | yes | built-in; `ABACUS_API_KEY` also accepted |
| `groq.env` | Groq | yes | OpenAI-compatible |
| `mistral.env` | Mistral AI | yes | OpenAI-compatible |
| `deepseek.env` | DeepSeek | yes | OpenAI-compatible |
| `together.env` | Together AI | yes | OpenAI-compatible |
| `fireworks.env` | Fireworks AI | yes | OpenAI-compatible |
| `perplexity.env` | Perplexity | yes | OpenAI-compatible |
| `xai-grok.env` | xAI (Grok) | yes | OpenAI-compatible |
| `google-gemini.env` | Google Gemini | yes | via Gemini's OpenAI-compatible endpoint |
| `azure-openai.env` | Azure OpenAI | yes | needs the `api-key` header — see the file |
| `ollama.env` | Ollama (local) | no | runs on your machine |
| `lmstudio.env` | LM Studio (local) | no | runs on your machine |

## Using more than one at once

You can combine several providers in a single `~/.mercury/.env` — paste the blocks from each
file together. `MERCURY_MODEL` picks the default; Mercury's router can still use any other
configured provider when a task calls for it. Keep only one `MERCURY_MODEL` line.

## Model names change

The `MERCURY_MODEL` value in each file is a sensible current default. Swap in any model the
provider offers — the format is always `provider/model-name`. Run `mercury models` to see what
Mercury currently knows about.

## Security

Never commit a filled-in `.env` with real keys. These examples contain placeholders only.
