# Skills

Skills sind Ordner mit einer `SKILL.md` (agentskills.io-Format: YAML-Frontmatter mit `name`
und `description`, gefolgt von Markdown-Anweisungen). Mercury listet die Skill-Beschreibungen im
System-Prompt auf und lädt die vollständigen Anweisungen bei Bedarf (`skill_view`). Der Agent kann
Skills nach dem Lösen schwieriger Aufgaben selbst erstellen und verbessern (`skill_create`, `skill_update`).

- `mercury skills list|view <name>|install <path-or-git-url>`
- `mercury new skill <name>`
- Mitgelieferte Skills liegen in `<repo>/skills`, Ihre eigenen in `~/.mercury/skills`.

## Selbst-destillierende Skills

Über handgeschriebene Skills hinaus kann Mercury **eigene** wiederverwendbare, parametrisierte
Skills aus gut verlaufenen Läufen destillieren. Dies ist **standardmäßig aus**
(`skills.distill.enabled: false`).

- **Wie ein Skill destilliert wird** — nach einem erfolgreichen Lauf oder wenn Sie einen Lauf mit
  👍 bewerten, wird die bewährte Werkzeugabfolge erfasst und ihre konkreten Werte werden zu
  benannten Parametern verallgemeinert. Ein neuer Verlauf, der einem bestehenden Skill stark ähnelt
  (≥ `dedupMinSimilarity`), aktualisiert diesen Skill und erhöht seine Version, statt ein Duplikat
  zu erzeugen.
- **Governance** — destillierte Skills beginnen als `proposed` und müssen vor der Wiederverwendung
  freigegeben werden (`autoApprove: true` überspringt die Prüfung). Freigeben/Ausmustern über das
  Admin-Panel **Destillierte Skills** oder via `POST /api/distilled-skills/:id/{approve,retire}`.
- **Hoch-/Herabstufen nach Nachweis** — jeder freigegebene Skill verfolgt seine Erfolgsquote und
  Ø-Kosten. Ein Skill, der nach mindestens `minRunsBeforeRetire` Nutzungen unter
  `retireBelowSuccessRate` fällt, wird automatisch ausgemustert; `maxSkills` begrenzt die Anzahl.
- **Wiederverwendung** — passt eine eingehende Aufgabe zu einem freigegebenen Skill
  (≥ `matchMinSimilarity`), wird dem Agenten der bewährte Weg als „proven skill“-Planhinweis
  angeboten, damit er die bewährte Prozedur ausführt.

### Konfiguration

```yaml
skills:
  distill:
    enabled: false              # Hauptschalter (destillieren / matchen / aufzeichnen)
    autoApprove: false          # Prüfung überspringen, neue Skills sofort freigeben
    minToolCalls: 2             # ein Gewinnerlauf braucht mind. so viele Werkzeugaufrufe
    matchMinSimilarity: 0.3     # Mindestähnlichkeit, um einen Skill für eine Aufgabe zu nutzen
    dedupMinSimilarity: 0.6     # Mindestähnlichkeit, um einen Verlauf als denselben Skill zu werten
    minRunsBeforeRetire: 5      # Nutzungen vor möglicher Auto-Ausmusterung
    retireBelowSuccessRate: 0.5 # Auto-Ausmusterung unter dieser Erfolgsquote
    maxSkills: 500              # harte Obergrenze; älteste ausgemusterte Skills werden entfernt
```

Das Web-UI-Panel **Destillierte Skills** (Admin) zeigt Status, Prüfwarteschlange und Skill-Statistiken.
