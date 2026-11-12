# Extending Mercury

- **Polyglot tool**: `mercury new tool <name> --lang python|js|go|cpp|java`
- **Skill**: `mercury new skill <name>`
- **Workflow**: `mercury new workflow <name>`
- **Platform adapter**: `mercury new adapter <name>` (TypeScript class extending `BaseAdapter`)
- **Plugin**: `mercury new plugin <name>` — register tools, hooks, LLM providers, workflow templates, commands.
See docs/EXTENDING.md in the repository.
