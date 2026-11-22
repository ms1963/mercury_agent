# Teams (multi-agent orchestration)

Teams compose several role-specialised agents into one governed, budget-aware run. A team is a
named, persisted definition of **members** (each with a role, optional model/pattern/toolsets and a
task template) plus a **strategy** that decides how they collaborate.

Teams are **disabled by default**. Enable them in `config.yaml`:

```yaml
teams:
  enabled: true
  maxMembers: 8
  defaultStrategy: coordinator   # coordinator | pipeline | debate
  budget: 0                      # 0 = no per-run ceiling; otherwise max total cost
  requireApproval: false         # gate every run behind an approval
```

## Strategies

- **coordinator** — the first member plans and delegates to the remaining members (workers) in
  parallel; their outputs are synthesised into a final answer.
- **pipeline** — members run sequentially, each receiving the previous member's output as context.
- **debate** — every member answers independently, then the results are synthesised (or the
  longest/strongest answer is picked).

## Governance & resilience

- Every run checks `teams.run` policy; defining/deleting teams checks `teams.manage` (admin).
- A **per-run budget ceiling** stops delegating to further members once the cost cap is hit; the
  remaining members are recorded as `skipped`.
- Member failures **degrade gracefully** — a crashing member becomes an `error` step and the run
  continues (status `partial`) instead of aborting.
- Definitions and run records are persisted and auditable.

## CLI

```bash
mercury team create researchers --members "lead:plan the research;writer:draft the report" --strategy coordinator
mercury team list
mercury team run researchers "Summarise the latest release" --budget 2
mercury team runs
mercury team show researchers
mercury team delete researchers
```

## REST

`GET/POST /api/teams`, `GET/DELETE /api/teams/:id`, `POST /api/teams/:id/run`,
`GET /api/teams/runs`, `GET /api/teams/runs/:id` — all auth-gated.
