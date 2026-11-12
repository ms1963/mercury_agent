# Skills

Skills are folders with a `SKILL.md` (agentskills.io format: YAML frontmatter with `name`
and `description`, then Markdown instructions). Mercury lists skill descriptions in the system
prompt and loads the full instructions on demand (`skill_view`). The agent can create and
improve skills itself after solving hard tasks (`skill_create`, `skill_update`).

- `mercury skills list|view <name>|install <path-or-git-url>`
- `mercury new skill <name>`
- Bundled skills live in `<repo>/skills`, your own in `~/.mercury/skills`.
