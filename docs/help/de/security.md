# Sicherheit

- Passwörter werden mit scrypt gehasht; Sitzungen verwenden signierte JWTs; API-Tokens (`mrc_…`) werden gehasht gespeichert und tragen Scopes.
- Rollenbasierte Zugriffssteuerung (`admin`, `user`) sowie benutzerspezifische Richtlinien-Überschreibungen.
- Gefährliche Tools erfordern eine Freigabe; Shell-Befehle werden gegen eine Sperrliste geprüft; Datei-Tools sind auf den Arbeitsbereich beschränkt.
- Tool-Ausgaben aus dem Web/aus Dateien werden als nicht vertrauenswürdig markiert; Guardrails erkennen Prompt-Injection-Muster und blockieren riskante Folgeaktionen.
- Geheimnisse werden aus Logs und der Einstellungs-API entfernt; das Audit-Log ist per Hash-Kette gesichert.
Siehe docs/SECURITY.md im Repository für das vollständige Modell.
