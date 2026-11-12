# Getting started

Install, set up an admin and talk to Mercury in under five minutes.

## Install
```
git clone <repo> mercury && cd mercury
npm install && npm run build
npm link            # optional: puts `mercury` on your PATH
```

## First run
```
mercury setup                 # interactive: admin user + LLM provider
mercury chat "hello"          # one-shot
mercury chat                  # interactive REPL
mercury serve --port 3000     # web UI + REST API + gateway + MCP endpoint
```
Without API keys Mercury uses the built-in **mock** provider (`mock/echo`), which echoes
messages and can call tools with `call:<tool> {json}` — handy for testing offline.

Set a real provider with environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_HOST`) or `mercury config set llm.defaultModel openai/gpt-4o-mini`.
Data lives in `~/.mercury` (override with `MERCURY_HOME`).
