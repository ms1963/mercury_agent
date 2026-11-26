# Shell-Vervollständigung

`mercury completion <bash|zsh|fish>` gibt ein Vervollständigungsskript für die `mercury`-CLI auf stdout
aus, sodass du es mit `source` laden oder dort speichern kannst, wo deine Shell Vervollständigungen lädt.
Das Skript wird aus der echten Befehlsliste erzeugt und bleibt so auf dem aktuellen Stand.

## Verwendung

```
mercury completion bash > /etc/bash_completion.d/mercury      # oder: aus ~/.bashrc sourcen
mercury completion zsh  > "${fpath[1]}/_mercury"               # danach Shell neu starten
mercury completion fish > ~/.config/fish/completions/mercury.fish
```

## Was vervollständigt wird

- Alle Top-Level-Befehle (`chat`, `serve`, `sessions`, `migrate`, `logs`, ...).
- Die gängigen Unterbefehle jedes Befehls, der welche hat (z. B. `migrate status|up`, `sessions list|...`).

## Hinweise

- Die Ausgabe ist ein reines Skript; es wird nichts für dich geschrieben oder installiert — du wählst den Ort.
- Erzeuge das Skript nach einem Mercury-Upgrade neu, damit neue Befehle vervollständigt werden.
