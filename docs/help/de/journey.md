# Journey-Zeitleiste

`mercury journey` ist eine chronologische Zeitleiste (**neueste zuerst**) der bedeutsamen Ereignisse des
Agenten, vollständig aus Daten erstellt, die Mercury **bereits aufzeichnet**. Der Befehl ist **nur
lesend** und fügt keine Instrumentierung hinzu.

## Ereignisarten

| Zeichen | Art | Quelle |
|---------|-----|--------|
| `M` | memory | ein Fakt wurde gebildet (`facts`) |
| `S` | skill | ein Skill wurde destilliert (`distilled_skills`) |
| `K` | knowledge | eine Quelle wurde eingelesen (`knowledge`) |
| `R` | run | ein Agenten-Lauf begann (`runs`) |
| `L` | learn | eine Reflexion / ein Lern-Ergebnis nach dem Lauf (`reflections`) |
| `·` | session | eine episodische Sitzung begann (`sessions`) |

## Verwendung

```
mercury journey [--since <Dauer|ISO>] [--until <Dauer|ISO>] [--limit <n>] [--kind <k1,k2>] [--json]
```

- `--since <d>` / `--until <d>` — auf ein Zeitfenster einschränken; eine Dauer (`30d`, `12h`, `2w`) oder
  ein ISO-Datum (die obere Grenze ist exklusiv).
- `--limit <n>` — höchstens N (neueste) Ereignisse anzeigen. Die ausgewiesenen Werte `total` und
  `counts` beziehen sich auf den gesamten Bereich vor der Begrenzung.
- `--kind <k1,k2>` — kommagetrennte Arten: `memory`, `skill`, `knowledge`, `run`, `learn`, `session`.
- `--json` — die vollständige Zeitleiste `{ events, counts, total, firstTs, lastTs, empty }` ausgeben.

Eine leere Historie gibt `no journey events recorded` aus und endet mit 0.
