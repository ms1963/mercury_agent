# Modelle, Router & Budgets

Modell-IDs haben die Form `provider/model` (z. B. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4`,
`ollama/llama3.1`, `mock/echo`). Provider werden aktiv, sobald ihr API-Schlüssel gesetzt ist.

- **Router**: wählt pro Aufgabe ein Modell anhand der Schwierigkeit (Jev-Urteil oder Heuristiken) und der Stufen in `router`.
- **Budgets**: tägliche/monatliche Kosten- und Token-Grenzen pro Benutzer oder global (`budgets.manage`). Bei Budgetüberschreitung → Ausweichmodell oder Ablehnung.
- **Jev** (`typesafe/jev-1.13` via OpenRouter): das Entscheidungsmodell, das für Routing, Injection-Prüfungen, Freigaben, Gateway-Triage und Reflexion verwendet wird. Aktiv, wenn `OPENROUTER_API_KEY` gesetzt ist (`decision.provider: auto`); andernfalls greift Mercury auf das konfigurierte LLM zurück und schließlich auf einen Mock-Richter.
