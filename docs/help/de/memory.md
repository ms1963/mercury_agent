# Gedächtnis

Mercury merkt sich Informationen über Sitzungen hinweg mithilfe mehrerer Schichten:

- **Fakten** — durchsuchbare Langzeit-Erinnerungen (Tools `memory_remember`, `memory_recall`; Web-Panel „Memory").
- **Kuratiertes Gedächtnis** — `MEMORY.md` (Agenten-Notizen) und `USER.md` (über Sie), in der Größe begrenzt, in jeden Prompt eingefügt.
- **Benutzermodell** — ein Profil der aus Gesprächen gelernten Vorlieben.
- **Sitzungssuche** — Volltextsuche über vergangene Gespräche.
- **Blackboard** — gemeinsamer Notizraum für Multi-Agenten-Workflows.

Verwenden Sie `/memory` im Chat oder das Memory-Panel, um Inhalte zu durchsuchen, zu bearbeiten und zu vergessen.

## Gesteuertes Gedächtnis & Wissen (v1.4.0)

Das Gedächtnis kann richtliniengesteuert, PII-bewusst, aufbewahrungsbegrenzt, namensraumfähig und
auditierbar sein. All dies ist **standardmäßig aus/weich** und abwärtskompatibel — bestehende Aufrufe
funktionieren weiter.

```yaml
memory:
  governance:
    mode: off            # off | soft | strict
    enforcePolicy: false # remember/recall/forget über die Richtlinien-Engine leiten
    pii:
      detect: true
      redact: true       # erkannte PII durch Platzhalter ersetzen
      block: false       # Schreibvorgänge mit PII ablehnen (strict)
  retention:
    ttlDays: 0                 # 0 = unbegrenzt behalten
    maxItemsPerNamespace: 0    # 0 = unbegrenzt; sonst älteste entfernen
  namespaces:
    default: default
    allowed: []                # wenn gesetzt (strict), nur diese Namensräume zulassen
  knowledge:
    enabled: false
    chunkChars: 900
    chunkOverlap: 120
    recallK: 4
```

- **Namensräume** ergänzen eine Dimension zusätzlich zum Nutzer-Scope; `remember`/`recall`/`forget`
  akzeptieren eine `namespace`-Option, und `mercury memory ns` listet sie mit Anzahl auf.
- **PII** wird erkannt (E-Mail, Karte, SSN, IP, Telefon) und je nach Konfiguration maskiert oder
  blockiert.
- **Aufbewahrung** entfernt beim Schreiben nach TTL und/oder maximaler Anzahl pro Namensraum.
- **Audit** — jede gesteuerte Entscheidung wird im abfragbaren `memory_audit`-Protokoll erfasst
  (`mercury memory audit`, `GET /api/memory/audit`), zusätzlich zum globalen Audit-Bus.
- **Wissen/RAG** — `mercury memory knowledge add` nimmt ein Dokument auf (zerteilt + eingebettet) und
  `mercury memory knowledge search` ruft Abschnitte mit **Herkunftsnachweis** über hybride
  FTS+Vektor-Suche ab. Bei `knowledge.enabled` fließt Wissen in `buildContext()` ein.
- Die Gedächtnis-Konfiguration ist ein **Bundle-Abschnitt** und kann mit Agent-Bundles exportiert/
  installiert werden.
