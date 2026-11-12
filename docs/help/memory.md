# Memory

Mercury remembers across sessions with several layers:

- **Facts** — searchable long-term memories (`memory_remember`, `memory_recall` tools; web Memory panel).
- **Curated memory** — `MEMORY.md` (agent notes) and `USER.md` (about you), bounded in size, injected into every prompt.
- **User model** — a profile of preferences learned from conversations.
- **Session search** — full-text search over past conversations.
- **Blackboard** — shared scratch space for multi-agent workflows.

Use `/memory` in chat or the Memory panel to browse, edit and forget.
