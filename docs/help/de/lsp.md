# LSP-Server (Language Server Protocol)

Stellt Mercury über das [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
(LSP) bereit, sodass LSP-fähige *Clients* — Editoren und IDEs wie VS Code, Neovim und Zed — den
Mercury-Agenten und die Werkzeugoberfläche über ihre eingebaute Language-Server-Anbindung erreichen können.
LSP **ergänzt den MCP- und den ACP-Server**: Während `mercury mcp serve` MCP-Clients den Aufruf der
Mercury-Werkzeuge ermöglicht und `mercury acp serve` einen ACP-Client den Agenten anfragen lässt, stellt
`mercury lsp serve` dieselbe zugrunde liegende Oberfläche einem LSP-Client bereit.

## Server starten — `mercury lsp serve`

LSP spricht JSON-RPC 2.0 über einen bidirektionalen Stream, gerahmt mit einem HTTP-ähnlichen Kopfblock
(`Content-Length: N\r\n\r\n<json>`, wobei `N` die UTF-8-**Byte**-Länge des Rumpfs ist) statt der
zeilenweisen Rahmung von ACP. Mercury bedient es über **stdio**: gerahmte Anfragen kommen auf stdin an,
gerahmte Antworten und `$/progress`-Benachrichtigungen werden auf stdout geschrieben. Der Prozess läuft,
bis der Client `exit` sendet oder stdin schließt.

- `mercury lsp serve` — stdio-Server starten, an den lokalen Admin-Benutzer gebunden.
- `mercury lsp serve --user <name>` — die Sitzung an einen bestimmten Mercury-Benutzer binden.

Dies ist der Modus, den ein LSP-Client als Unterprozess startet. Normalerweise konfiguriert man seinen
Editor so, dass er `mercury lsp serve` ausführt, statt es von Hand aufzurufen.

## Protokolloberfläche inspizieren

- `mercury lsp` / `mercury lsp info` — zeigt die angestrebte Protokollversion, die beworbene `serverInfo`
  und die Fähigkeiten sowie die implementierte Methodenoberfläche. `--json` für die strukturierte Form
  (einschließlich der erreichbaren Werkzeugnamen).
- `mercury lsp methods` — listet die JSON-RPC-Methoden auf, die dieser Server verarbeitet (`--json` für
  strukturierte Ausgabe).

## Wire-Oberfläche (JSON-RPC 2.0 über stdio, Content-Length-gerahmt)

| Methode | Art | Zweck |
|---|---|---|
| `initialize` | Request | Fähigkeiten aushandeln → `{ capabilities, serverInfo }`. |
| `initialized` | Benachrichtigung | Bestätigung des Clients nach `initialize`. |
| `shutdown` | Request | Sauberes Herunterfahren anfordern (antwortet mit `null`). |
| `exit` | Benachrichtigung | Die Serve-Schleife beenden. |
| `textDocument/didOpen` | Benachrichtigung | Ein geöffnetes Dokument verfolgen (uri → Version + Text). |
| `textDocument/didChange` | Benachrichtigung | Eine Volltextänderung auf ein verfolgtes Dokument anwenden. |
| `textDocument/didClose` | Benachrichtigung | Ein Dokument nicht mehr verfolgen. |
| `workspace/executeCommand` | Request | Einen Mercury-Befehl ausführen: `mercury.prompt`, `mercury.tools.list`, `mercury.tools.call`. |
| `_mercury/agent/prompt` | Request | Einen Agenten-Prompt-Turn ausführen (Hersteller-Erweiterung). |
| `_mercury/tools/list` | Request | Mercury-Werkzeugspezifikationen auflisten (Hersteller-Erweiterung). |
| `_mercury/tools/call` | Request | Ein Mercury-Werkzeug per Name aufrufen (Hersteller-Erweiterung). |

Während ein Agenten-Turn läuft (`mercury.prompt` oder `_mercury/agent/prompt`), streamt der Agent
`$/progress`-Benachrichtigungen an den Client zurück — Werkzeugaufruf-Fortschritt sowie den finalen
`agent_message_chunk` —, und die Anfrage antwortet dann mit `{ output, stopReason }` (`end_turn`,
`cancelled`, `error`).

### Dokument-Synchronisierung

Der Server bewirbt **vollständige** Dokument-Synchronisierung (`textDocumentSync.change = 1`): Jedes
`textDocument/didChange` trägt den gesamten neuen Text, und der Server hält pro uri die neueste Version +
den Text. Geöffnete Dokumente werden ab `didOpen` verfolgt und bei `didClose` verworfen.

## In `initialize` beworbene Fähigkeiten

```json
{
  "capabilities": {
    "textDocumentSync": { "openClose": true, "change": 1 },
    "executeCommandProvider": { "commands": ["mercury.prompt", "mercury.tools.list", "mercury.tools.call"] }
  },
  "serverInfo": { "name": "mercury", "version": "1.9.0" }
}
```

## Architektur

Die Kernlogik liegt in `packages/core/src/lsp/lsp.ts`, aufgeteilt in **reine** Funktionen — die
Content-Length-Rahmung (`encodeLspMessage` / `decodeLspFrames`, die partielle Puffer und mehrere
Nachrichten in einem Chunk behandeln), den JSON-RPC-Parser und die Anfrageverteilung (mit einem injizierten
Agenten-Stub und einer injizierten Benachrichtigungssenke unit-testbar) — sowie eine dünne
stdio-Transportschicht (`serveLspStdio`), die die Rahmung über echte Streams erledigt. Der Runtime-Adapter
`m.lspAgent(principal)` bindet einen Principal per Closure — genau wie der `serveStdio` des MCP-Servers und
der Adapter des ACP-Servers — und stellt dieselbe Agenten-Lauf- und Werkzeugaufruf-Oberfläche wie das
MCP-Backend bereit (sein `LspAgent`-Typ ist ein Alias für das ACP-`AcpAgent`).

## Status / Ehrlichkeit

Die Rahmung, jeder Methoden-Handler und die Fehlerpfade werden offline und deterministisch von
`tests/lsp.test.ts` gegen injizierte Stubs und In-Memory-Streams ausgeübt. Das `$/progress`-Streaming ist
über die injizierte Update-Senke verdrahtet und mit einem Stub getestet, der es antreibt; der
Runtime-Adapter gibt die endgültige Ausgabe des Agenten als einzelnen `agent_message_chunk` zurück. Der
Server wurde **nicht** gegen einen echten externen LSP-Client (z. B. VS Code / Zed) ausgeübt — nur gegen
die deterministischen Offline-Tests.
