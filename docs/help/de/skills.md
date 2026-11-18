# Skills

Skills sind Ordner mit einer `SKILL.md` (agentskills.io-Format: YAML-Frontmatter mit `name`
und `description`, gefolgt von Markdown-Anweisungen). Mercury listet die Skill-Beschreibungen im
System-Prompt auf und lädt die vollständigen Anweisungen bei Bedarf (`skill_view`). Der Agent kann
Skills nach dem Lösen schwieriger Aufgaben selbst erstellen und verbessern (`skill_create`, `skill_update`).

- `mercury skills list|view <name>|install <path-or-git-url>`
- `mercury new skill <name>`
- Mitgelieferte Skills liegen in `<repo>/skills`, Ihre eigenen in `~/.mercury/skills`.
