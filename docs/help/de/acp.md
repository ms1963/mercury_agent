# ACP-Server (Agent Client Protocol)

Stellt Mercury über das [Agent Client Protocol](https://agentclientprotocol.com) (ACP) bereit, sodass
externe *Clients* — Editoren und IDEs wie Zed — eine Sitzung öffnen und den Mercury-Agenten steuern
können. ACP **ergänzt den MCP-Server**: Während `mercury mcp serve` MCP-Clients den Aufruf der
Mercury-Werkzeuge ermöglicht, lässt `mercury acp serve` einen ACP-Client den Mercury-Agenten anfragen
und erreicht dieselbe zugrunde liegende Werkzeugoberfläche.

## Server starten — `mercury acp serve`

ACP spricht JSON-RPC 2.0 über einen bidirektionalen Stream. Mercury bedient es über **stdio** als
zeilengetrenntes JSON (eine Nachricht pro Zeile): Anfragen kommen auf stdin an, Antworten und
`session/update`-Benachrichtigungen werden auf stdout geschrieben. Der Prozess läuft, bis stdin schließt.

- `mercury acp serve` — stdio-Server starten, an den lokalen Admin-Benutzer gebunden.
- `mercury acp serve --user <name>` — die Sitzung an einen bestimmten Mercury-Benutzer binden.

Dies ist der Modus, den ein ACP-Client als Unterprozess startet. Normalerweise konfiguriert man seinen
Editor so, dass er `mercury acp serve` ausführt, statt es von Hand aufzurufen.

## Protokolloberfläche inspizieren

- `mercury acp` / `mercury acp info` — zeigt die ausgehandelte Protokollversion, die beworbenen
  Fähigkeiten und die implementierte Methodenoberfläche. `--json` für die strukturierte Form
  (einschließlich der erreichbaren Werkzeugnamen).
- `mercury acp methods` — listet die JSON-RPC-Methoden auf, die dieser Server verarbeitet (`--json` für
  strukturierte Ausgabe).

## Wire-Oberfläche (JSON-RPC 2.0 über stdio)

| Methode | Art | Zweck |
|---|---|---|
| `initialize` | Request | Ganzzahlige Protokollversion aushandeln und Fähigkeiten austauschen. Es werden keine Auth-Methoden beworben. |
| `session/new` | Request | Eine Konversationssitzung öffnen → `{ sessionId }`. |
| `session/list` | Request | Offene Sitzungen auflisten. |
| `session/prompt` | Request | Einen Prompt-Turn ausführen; streamt `session/update`-Benachrichtigungen und antwortet dann mit `{ stopReason }`. |
| `session/cancel` | Benachrichtigung | Den laufenden Turn einer Sitzung abbrechen. |
| `_mercury/tools/list` | Request | Mercury-Werkzeugspezifikationen auflisten (Hersteller-Erweiterung; ACP reserviert den `_`-Präfix). |
| `_mercury/tools/call` | Request | Ein Mercury-Werkzeug per Name aufrufen (Hersteller-Erweiterung). |

Während eines `session/prompt`-Turns streamt der Agent `session/update`-Benachrichtigungen an den Client
zurück: `agent_message_chunk` (Assistententext) sowie alle vom Agenten ausgegebenen `tool_call` /
`tool_call_update`. Wenn der Turn endet, trägt die `session/prompt`-Antwort einen `stopReason`
(`end_turn`, `cancelled`, `error`).

### Nicht unterstützt (bewusst)

- `session/load` — der Agent bewirbt `loadSession: false`; Sitzungen sind über Neustarts hinweg nicht
  wiederaufnehmbar.
- `auth/login` / `auth/logout` / `authenticate` — der Agent bewirbt ein leeres `authMethods`-Array, daher
  dürfen diese nicht aufgerufen werden (sie liefern einen JSON-RPC-Fehler *method not found*). Die
  Authentifizierung wird beim Start über `--user` gebunden.

## In `initialize` beworbene Fähigkeiten

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "sessionCapabilities": { "list": true }
  },
  "authMethods": []
}
```

## Architektur

Die Kernlogik liegt in `packages/core/src/acp/acp.ts`, aufgeteilt in **reine** Funktionen zum Parsen und
Verteilen von Anfragen (mit einem injizierten Agenten-Stub und einer injizierten
Benachrichtigungssenke unit-testbar) sowie eine dünne stdio-Transportschicht (`serveAcpStdio`), die
zeilengetrenntes JSON rahmt. Der Runtime-Adapter `m.acpAgent(principal)` bindet einen Principal per
Closure — genau wie der `serveStdio` des MCP-Servers einen Principal bindet — und stellt dieselbe
Agenten-Lauf- und Werkzeugaufruf-Oberfläche wie das MCP-Backend bereit.

## Status / Ehrlichkeit

Jeder Methoden-Handler, die JSON-RPC-Rahmung und die Fehlerpfade werden offline und deterministisch von
`tests/acp.test.ts` gegen injizierte Stubs ausgeübt. Das Streaming der `session/update`-Benachrichtigungen
für Werkzeugaufrufe ist über die injizierte Update-Senke verdrahtet und mit einem Stub getestet, der sie
antreibt; der Runtime-Adapter gibt die endgültige Ausgabe des Agenten als einzelnen
`agent_message_chunk` zurück. Der Server wurde **nicht** gegen einen echten externen ACP-Client (z. B.
Zed) ausgeübt — nur gegen die deterministischen Offline-Tests.
