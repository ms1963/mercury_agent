# Prompt-Größe

`mercury prompt-size` schätzt, wie groß der zusammengesetzte System-Prompt/-Kontext ist, aufgeschlüsselt
nach Komponente, in Zeichen und einer ungefähren Token-Anzahl.

## Verwendung

```
mercury prompt-size [--json]
```

## Was gemessen wird

Der Befehl misst die realen, offline verfügbaren Komponenten des System-Prompts, den der Agent zusammensetzt:

- **System-Prompt (Persona)** — der Prompt der aktiven Persönlichkeit.
- **Instruktionshierarchie** — der in jeden Prompt eingefügte Sicherheits-/Instruktionshierarchie-Block.
- **Skills-/Tools-Index** — der Katalog der dem Modell angebotenen Skills/Tools.
- **Speicher/Kontext** — hier als `0` ausgewiesen (siehe Näherungs-Hinweis).

## Näherung

Die Token-Zahlen sind eine Heuristik von etwa **4 Zeichen pro Token** — kein echter Tokenizer — und daher
als Schätzwerte zu verstehen. Die sitzungsabhängigen Teile (Gesprächsspeicher, abgerufener Kontext,
Hinweise pro Zug) existieren nur während eines Live-Laufs und werden deshalb als `0` ausgewiesen. Die Summe
ist somit eine **Untergrenze-Schätzung** des statischen Basis-Prompts, kein exakter Wert pro Anfrage.

## Ausgabe

Eine Tabelle der Komponenten mit Zeichen und ungefähren Tokens sowie eine `TOTAL`-Zeile. `--json` gibt den
vollständigen Bericht aus (`components`, `totalChars`, `totalTokens`, `approximate`).
