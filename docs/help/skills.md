# Skills

Skills are folders with a `SKILL.md` (agentskills.io format: YAML frontmatter with `name`
and `description`, then Markdown instructions). Mercury lists skill descriptions in the system
prompt and loads the full instructions on demand (`skill_view`). The agent can create and
improve skills itself after solving hard tasks (`skill_create`, `skill_update`).

- `mercury skills list|view <name>|install <path-or-git-url>`
- `mercury new skill <name>`
- Bundled skills live in `<repo>/skills`, your own in `~/.mercury/skills`.

## Self-distilling skills

Beyond hand-written skills, Mercury can **distil its own** reusable, parameterized skills from
runs that went well. This is **off by default** (`skills.distill.enabled: false`).

- **How a skill is distilled** — after a successful run, or when you 👍 a run, the proven tool
  sequence is captured and its concrete values are generalized into named parameters. A new trace
  that closely matches an existing skill (≥ `dedupMinSimilarity`) updates that skill and bumps its
  version instead of creating a duplicate.
- **Governance** — distilled skills start as `proposed` and must be approved before the agent may
  reuse them (set `autoApprove: true` to skip review). Approve/retire from the **Distilled Skills**
  admin panel or via `POST /api/distilled-skills/:id/{approve,retire}`.
- **Promote/demote by evidence** — each approved skill tracks its success rate and average cost.
  A skill that falls below `retireBelowSuccessRate` after at least `minRunsBeforeRetire` uses is
  auto-retired; `maxSkills` caps how many are kept.
- **Reuse** — when an incoming task matches an approved skill (≥ `matchMinSimilarity`), the proven
  path is offered to the agent as a "proven skill" plan hint so it runs the known-good procedure.

### Config

```yaml
skills:
  distill:
    enabled: false              # master switch (distil / match / record)
    autoApprove: false          # skip review and approve new skills immediately
    minToolCalls: 2             # a winning run needs at least this many tool calls to distil
    matchMinSimilarity: 0.3     # min similarity to reuse an approved skill for a task
    dedupMinSimilarity: 0.6     # min similarity to treat a trace as the same skill (version)
    minRunsBeforeRetire: 5      # uses required before auto-retire can apply
    retireBelowSuccessRate: 0.5 # auto-retire below this observed success rate
    maxSkills: 500              # hard cap; oldest retired skills pruned beyond it
```

The Web UI **Distilled Skills** panel (admin) shows status, the review queue and per-skill stats.
