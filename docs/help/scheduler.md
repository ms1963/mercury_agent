# Scheduler

Schedule recurring or one-off agent tasks with natural language or cron:

```
mercury schedule add --when "every weekday at 9am" Summarise my inbox
mercury schedule add --when "0 */6 * * *" Check the build status
mercury schedule add --when "in 20 minutes" Remind me to stretch
```
Results are delivered to the originating platform (CLI log, web, Telegram, …). Manage with
`mercury schedule list|pause|resume|delete|run` or the Scheduler panel. If a schedule cannot be
parsed, use a 5-field cron expression.
