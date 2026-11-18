# Planer

Planen Sie wiederkehrende oder einmalige Agenten-Aufgaben mit natürlicher Sprache oder Cron:

```
mercury schedule add --when "every weekday at 9am" Summarise my inbox
mercury schedule add --when "0 */6 * * *" Check the build status
mercury schedule add --when "in 20 minutes" Remind me to stretch
```
Ergebnisse werden an die ursprüngliche Plattform geliefert (CLI-Log, Web, Telegram, …). Verwalten Sie sie mit
`mercury schedule list|pause|resume|delete|run` oder dem Planer-Panel. Wenn eine Planung nicht
geparst werden kann, verwenden Sie einen Cron-Ausdruck mit 5 Feldern.
