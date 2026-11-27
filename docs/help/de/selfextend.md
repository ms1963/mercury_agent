# Selbst-erweiternde Tools (dynamische Tool-Synthese)

`mercury selfextend` ermöglicht es Mercury, ein **völlig neues Tool zu entwerfen**, wenn eine
Fähigkeit wiederholt benötigt wird, aber kein registriertes Tool sie bereitstellt. Dies ist eine
**hochriskante** Funktion: Mercury schreibt und führt Code aus, den es selbst verfasst hat. Deshalb
ist sie **STANDARDMÄSSIG DEAKTIVIERT** und jeder Schritt der Pipeline ist abgesichert.

> Solange `selfExtension.enabled = false` (Standard) ist, ist das gesamte Subsystem ein hartes No-op:
> Es werden keine Lücken verfolgt, keine Entwürfe erstellt, nichts registriert, und die
> CLI/Web/API-Oberflächen antworten mit einer lokalisierten „deaktiviert"-Meldung. Der Hauptschalter
> ist der Not-Aus.

## Die Pipeline (jeder Schritt abgesichert)

1. **Lückenerkennung (Schwellenwert).** Wenn ein Tool-Aufruf fehlschlägt, weil kein Tool passt, gibt
   die Laufzeit ein `tool.miss`-Ereignis aus. Eine Lücke gilt erst dann als *echt*, wenn dieselbe
   Fähigkeit `selfExtension.missThreshold`-mal verfehlt wurde (Standard **3**). Das verhindert, dass
   einmalige Fehlschläge die Synthese auslösen.
2. **Verfassen (LLM).** Ein injizierter LLM-Runner wird gebeten, einen Entwurf zu verfassen: einen
   Tool-Namen, eine Beschreibung, ein Eingabeschema, eine Implementierung (Python oder Node), einen
   **generierten Unit-Test** und ein **Fähigkeitsmanifest nach dem Least-Privilege-Prinzip**, das
   genau deklariert, was das Tool benötigt (Dateisystem / Netzwerk / bestimmte Hosts / Shell).
3. **Validierung (vor der Registrierung).** Der Entwurf muss der Reihe nach bestehen:
   - **Manifest-Richtlinie (Deny-by-default):** Jede vom Entwurf angeforderte Fähigkeit muss in der
     Konfiguration ausdrücklich gewährt sein. Ein Entwurf, der eine nicht deklarierte oder unzulässige
     Fähigkeit anfordert, wird **abgelehnt** — Mercury erweitert niemals seine eigenen Rechte.
   - **Kompilierprüfung:** Die Implementierung muss kompilieren (`python3 -m py_compile` /
     `node --check`), ausgeführt außerhalb des Prozesses mit bereinigter Umgebung und Zeitlimit.
   - **Generierter Unit-Test:** Der zusammen mit dem Tool verfasste Test muss bestehen, erneut
     außerhalb des Prozesses.

   Ein Entwurf, der eine Stufe nicht besteht, wird nie zu einem registrierten Tool.
4. **Freigabe-Gating.** Ein validierter Entwurf wird als **PENDING** gespeichert. Er kann nicht
   laufen, bis ein Mensch ihn freigibt (`selfextend approve <id>`), es sei denn,
   `selfExtension.autoApprove = true` ist ausdrücklich konfiguriert. Eine Ablehnung
   (`selfextend deny <id>`) markiert ihn dauerhaft als nicht ausführbar und entfernt jeden
   persistierten Ordner.
5. **Sandbox-Ausführung.** Freigegebene Tools werden als **polyglotte Tool-Ordner** (`tool.json` +
   `main.py` / `main.mjs`) unter `<dataDir>/synth-tools/` persistiert und laufen **außerhalb des
   Prozesses** hinter der bestehenden Sandbox-Grenze — niemals per `eval` in der Haupt-Laufzeit. Die
   Umgebung wird von Geheimnissen bereinigt, Netzwerk ist nur verfügbar, wenn das Manifest es
   deklariert hat, und Ausgabe/Zeit sind begrenzt.
6. **Herkunft & Audit.** Jedes Verfassen / Validieren / Freigeben / Ablehnen / Ausführen wird im
   Audit-Log festgehalten, und jeder Tool-Ordner führt eine `.synth.json` mit seiner Herkunft
   (Fähigkeit, Prompt-Digest, Manifest, Validierungsergebnis, Freigebender).
7. **Persistenz.** Freigegebene Tools werden beim nächsten Start automatisch neu geladen, sodass die
   Fähigkeit über Sitzungen hinweg erhalten bleibt.

## Verwendung

```
mercury selfextend status [--json]
mercury selfextend enable | disable
mercury selfextend list [pending|approved|denied] [--json]
mercury selfextend gaps [--json]
mercury selfextend synthesize <capability...> [--json]
mercury selfextend approve <id>
mercury selfextend deny <id>
```

- `status` — zeigt, ob die Funktion aktiviert ist, sowie die aktuelle Richtlinie + Zähler. `--json`
  für Rohdaten.
- `enable` / `disable` — schaltet `selfExtension.enabled` in der Konfigurationsdatei um (der
  Haupt-Not-Aus).
- `list [state]` — listet synthetisierte Tools auf, optional gefiltert nach `pending` / `approved` /
  `denied`.
- `gaps` — listet verfolgte Fähigkeitslücken auf, die am häufigsten verfehlten zuerst.
- `synthesize <capability...>` — verfasst + validiert jetzt ein Tool für eine Fähigkeit (erstellt
  einen PENDING-Eintrag). Schlägt deutlich fehl, wenn die Funktion deaktiviert ist.
- `approve <id>` — gibt ein validiertes Tool für seinen ersten Lauf frei (persistiert +
  registriert es sofort).
- `deny <id>` — lehnt ein Tool ab (es kann nie laufen) und entfernt jeden persistierten Ordner.

## Konfiguration

Unter `selfExtension:` in der Konfigurationsdatei:

| Schlüssel | Standard | Bedeutung |
|-----------|----------|-----------|
| `enabled` | `false` | Haupt-Not-Aus. Alles ist ein No-op, solange false. |
| `missThreshold` | `3` | Wie viele Verfehlungen derselben Fähigkeit, bevor eine Lücke umsetzbar ist. |
| `autoApprove` | `false` | Wenn true, werden validierte Tools automatisch freigegeben (NICHT empfohlen). |
| `allowFilesystem` | `false` | Erlaubt Entwürfen, Dateisystemzugriff zu deklarieren. |
| `allowNetwork` | `false` | Erlaubt Entwürfen, Netzwerkzugriff zu deklarieren. |
| `allowedHosts` | `[]` | Exakte Hosts oder `*.suffix`-Platzhalter, die ein vernetzter Entwurf erreichen darf. |
| `allowShell` | `false` | Erlaubt Entwürfen, Shell-Zugriff zu deklarieren (dringend abgeraten). |
| `runtimes` | `['python','node']` | Welche Laufzeiten ein Entwurf anvisieren darf. |
| `timeoutMs` | `15000` | Wanduhr-Limit pro Ausführung (Kompilieren, Test und Lauf). |
| `maxOutputChars` | `20000` | Ausgabe-Obergrenze pro Ausführung. |
| `dir` | *(dataDir/synth-tools)* | Wo freigegebene Tool-Ordner persistiert werden. |

Du kannst die Funktion auch über die Web-Oberfläche (**Self-Extend**-Panel, nur Admin) und über die
API umschalten (`GET /api/selfextend`, `POST /api/selfextend/toggle`,
`POST /api/selfextend/:id/approve|deny`).

## Sicherheit / Bedrohungsmodell

Siehe den eigenen Abschnitt zum Bedrohungsmodell in `docs/HANDBOOK.md` und `docs/GAPS.md`. Kurz gesagt
sind die Gegenmaßnahmen: **standardmäßig deaktiviert (Not-Aus)**, **Fähigkeitsmanifest nach
Deny-by-default**, **keine impliziten Geheimnisse** an generierten Code, **verpflichtende Freigabe vor
dem ersten Lauf**, ein **Validierungs- + generierter-Test-Gate vor der Registrierung**,
**Out-of-Process-Sandbox-Ausführung** (niemals `eval`), **Ressourcen-/Zeit-/Ausgabe-Limits**, ein
**vollständiger Audit-Trail mit Herkunft** und **Ablehnung überprivilegierter Entwürfe**.

### Ehrlicher Status

Die Infrastruktur (Lückenerkennung, Autoren-Kontrakt, Validierungs-Gate, Freigabe-Gating, Richtlinie,
Persistenz, Audit, CLI/Web/API, i18n) ist implementiert und durch Offline-Tests abgedeckt, die
gestubbte LLM-Runner und echte lokale Kompilier-/Test-Runner verwenden. Was in CI **nicht** verifiziert
ist: die Qualität der von einem echten Produktions-LLM erzeugten Entwürfe und die Ausführung innerhalb
der vollständigen polyglotten/Docker-Host-Sandbox (CI übt den leichteren
Host-Kindprozess-Kompilier-/Test-Pfad aus). Betrachte das Verfassen durch ein echtes LLM und die
Produktions-Sandbox-Ausführung als experimentell.
