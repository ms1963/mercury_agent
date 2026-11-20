# Planer

Planen Sie wiederkehrende oder einmalige Agenten-Aufgaben mit natürlicher Sprache oder Cron:

```
mercury schedule add --when "every weekday at 9am" Summarise my inbox
mercury schedule add --when "0 */6 * * *" Check the build status
mercury schedule add --when "in 20 minutes" Remind me to stretch
```
Ergebnisse werden an die ursprüngliche Plattform geliefert (CLI-Log, Web, Telegram, …). Verwalten Sie sie mit
`mercury schedule list|edit|pause|resume|delete|run` oder dem Planer-Panel. Wenn eine Planung nicht
geparst werden kann, verwenden Sie einen Cron-Ausdruck mit 5 Feldern.

**Eine bestehende Planung bearbeiten** — Aufgabe, Zeitpunkt, Name, Zustellung oder Wiederholungslimit
ändern, ohne sie neu anzulegen. Geben Sie eine beliebige Teilmenge der Felder an (mindestens eines ist
erforderlich); eine Änderung von `--when` berechnet den nächsten Lauf neu:

```
mercury schedule edit <id> --when "every 3 hours" --name "AI News" --task "Summarise top AI headlines"
mercury schedule edit <id> --deliver telegram:123456 --max-retries 5
```

Klicken Sie im Planer-Panel bei einer Zeile auf **Edit**, um einen Inline-Editor zu öffnen
(Name / When / Task vorausgefüllt), ändern Sie das Gewünschte und drücken Sie **Save**.
