# Sicherheit

- Passwörter werden mit scrypt gehasht; Sitzungen verwenden signierte JWTs; API-Tokens (`mrc_…`) werden gehasht gespeichert und tragen Scopes.
- Rollenbasierte Zugriffssteuerung (`admin`, `user`) sowie benutzerspezifische Richtlinien-Überschreibungen.
- Gefährliche Tools erfordern eine Freigabe; Shell-Befehle werden gegen eine Sperrliste geprüft; Datei-Tools sind auf den Arbeitsbereich beschränkt.
- Tool-Ausgaben aus dem Web/aus Dateien werden als nicht vertrauenswürdig markiert; Guardrails erkennen Prompt-Injection-Muster und blockieren riskante Folgeaktionen.
- Geheimnisse werden aus Logs und der Einstellungs-API entfernt; das Audit-Log ist per Hash-Kette gesichert.

## Supply-Chain-Audit — `mercury security audit`

Prüft deine Abhängigkeiten über die kostenlose [OSV.dev](https://osv.dev)-API (ohne API-Schlüssel) auf bekannte Schwachstellen:

- `mercury security audit` — menschenlesbarer Bericht, gruppiert nach Quelle (npm / mcp / plugin).
- `mercury security audit --json` — vollständiger maschinenlesbarer Bericht.
- Einschränkende Flags (Standard = alle Quellen): `--npm`, `--mcp`, `--plugins`.
- `--lockfile <pfad>` — überschreibt den Pfad der npm-Lockfile (Standard: `package-lock.json` im Repo).
- Exit-Codes (CI-tauglich): `0` sauber, `1` Schwachstellen gefunden, `2` nicht abschließbar (z. B. OSV nicht erreichbar).

Geprüfte Quellen: npm-Pakete aus `package-lock.json`, npm-Pakete hinter konfigurierten MCP-Servern sowie
installierte Plugins samt ihrer npm-Abhängigkeiten. Jeder Fund zeigt die CVE-/Advisory-ID, den Schweregrad
und die behobene Version (sofern von OSV geliefert), eine kurze Zusammenfassung und die Quelle an.

Siehe docs/SECURITY.md im Repository für das vollständige Modell.
