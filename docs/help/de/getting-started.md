# Erste Schritte

Installieren, einen Administrator einrichten und in weniger als fünf Minuten mit Mercury sprechen.

## Installation
```
git clone <repo> mercury && cd mercury
npm install && npm run build
npm link            # optional: legt `mercury` in Ihren PATH
```

## Erster Start
```
mercury setup                 # interaktiv: Administrator-Benutzer + LLM-Provider
mercury chat "hello"          # einmalig
mercury chat                  # interaktive REPL
mercury serve --port 3000     # Web-UI + REST-API + Gateway + MCP-Endpunkt
```
Ohne API-Schlüssel verwendet Mercury den eingebauten **Mock**-Provider (`mock/echo`), der
Nachrichten zurücksendet und Tools mit `call:<tool> {json}` aufrufen kann — praktisch zum Testen offline.

Legen Sie einen echten Provider über Umgebungsvariablen fest (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_HOST`) oder mit `mercury config set llm.defaultModel openai/gpt-4o-mini`.
Daten liegen in `~/.mercury` (überschreibbar mit `MERCURY_HOME`).
