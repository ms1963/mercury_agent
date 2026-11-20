# Scheduler

Schedule recurring or one-off agent tasks with natural language or cron:

```
mercury schedule add --when "every weekday at 9am" Summarise my inbox
mercury schedule add --when "0 */6 * * *" Check the build status
mercury schedule add --when "in 20 minutes" Remind me to stretch
```
Results are delivered to the originating platform (CLI log, web, Telegram, …). Manage with
`mercury schedule list|edit|pause|resume|delete|run` or the Scheduler panel. If a schedule cannot be
parsed, use a 5-field cron expression.

**Edit an existing schedule** — change the task, the time, the name, delivery or retry limit without
recreating it. Pass any subset of the fields (at least one is required); changing `--when` recomputes
the next run:

```
mercury schedule edit <id> --when "every 3 hours" --name "AI News" --task "Summarise top AI headlines"
mercury schedule edit <id> --deliver telegram:123456 --max-retries 5
```

In the Scheduler panel, click **Edit** on a row to open an inline editor (Name / When / Task prefilled),
change what you need and press **Save**.
