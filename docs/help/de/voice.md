# Sprache

Mercury transkribiert Spracheingaben (Mikrofonaufnahmen im Web, Sprachmemos auf Chat-Plattformen)
und kann Antworten vorlesen. Sprache-zu-Text (STT) und Text-zu-Sprache (TTS) sind **unabhängig
voneinander austauschbar** zwischen einer kommerziellen Cloud-API und einer quelloffenen /
selbst gehosteten Lösung — eine einzige Konfigurationsänderung, keine Codeänderung.

## Benannte Presets — ein Befehl (empfohlen)

Der schnellste Weg, die STT/TTS-Lösung (offline oder online) auszutauschen, ist ein benanntes
Preset. Jedes Preset bündelt die passenden Schlüssel `provider` / `baseUrl` / `command` / `model`
für eine bekannte Engine, sodass du sie nicht einzeln setzen musst.

```sh
mercury voice presets              # alle STT- und TTS-Presets mit Offline/Online-Kennzeichnung auflisten
mercury voice use stt whisper      # vollständig offline, lokales CLI-STT
mercury voice use tts kokoro       # selbst gehostetes quelloffenes TTS (Kokoro-FastAPI)
mercury voice use tts openai       # zurück zum kommerziellen OpenAI-Cloud-TTS
mercury voice show                 # aktuelle Sprachkonfiguration anzeigen
```

`use` schreibt den **gesamten** `voice.stt`- oder `voice.tts`-Block in einer deklarativen
Neukonfiguration, sodass keine veralteten Schlüssel der vorherigen Engine zurückbleiben.

- **STT-Presets:** `openai` (online, kommerziell), `speaches` (offline, selbst gehostet,
  faster-whisper), `whisper` (offline, lokales CLI).
- **TTS-Presets:** `openai` (online, kommerziell), `openedai` (offline, selbst gehostet),
  `kokoro` (offline, selbst gehostet), `piper` (offline, lokales CLI), `edge-tts` (online, kostenlos).

Die einzelnen Schlüssel unten bleiben für die Feinabstimmung nach dem Anwenden eines Presets
verfügbar.

## Sprache-zu-Text — `voice.stt.provider`

- `openai` (Standard) / `openai-compatible` — OpenAI-Stil `POST {baseUrl}/audio/transcriptions`.
  Mit der Standard-`baseUrl` (`https://api.openai.com/v1`) ist dies die kommerzielle Whisper-API
  und benötigt einen Schlüssel in `OPENAI_API_KEY`. **Richte `voice.stt.baseUrl` auf einen selbst
  gehosteten Server**, der dieselbe Route bereitstellt (z. B. faster-whisper-server, Speaches), um
  vollständig quelloffen zu arbeiten — der Schlüssel ist für Nicht-OpenAI-Hosts optional.
- `whisper` / `command` — lokales CLI (vollständig offline). Verwendet `voice.stt.command`.
- `mock` — nur für Tests; nur verfügbar, wenn `MERCURY_ENABLE_MOCK=1` gesetzt ist.

Schlüssel: `voice.stt.baseUrl`, `voice.stt.apiKeyEnv` (Standard `OPENAI_API_KEY`),
`voice.stt.model` (Standard `whisper-1`), `voice.stt.format`, `voice.stt.command`.

## Text-zu-Sprache — `voice.tts.provider`

- `openai` (Standard) / `openai-compatible` — OpenAI-Stil `POST {baseUrl}/audio/speech`. Richte
  `voice.tts.baseUrl` auf einen selbst gehosteten Server (z. B. openedai-speech, Kokoro-FastAPI)
  für einen quelloffenen Wechsel.
- `piper` — offline neuronales TTS (MIT/Apache-Ökosystem), über `voice.tts.command`.
- `edge-tts` — kostenlose Microsoft-Edge-Stimmen (benötigt das `edge-tts`-CLI).
- `command` — beliebiges eigenes CLI.
- `mock` — nur für Tests; nur verfügbar, wenn `MERCURY_ENABLE_MOCK=1` gesetzt ist.

Schlüssel: `voice.tts.baseUrl`, `voice.tts.apiKeyEnv` (Standard `OPENAI_API_KEY`),
`voice.tts.model` (Standard `gpt-4o-mini-tts`), `voice.tts.voice` (Standard `alloy`),
`voice.tts.format` (Standard `mp3`), `voice.tts.command`.

## Wechseln (Beispiele)

```sh
# Kommerzielles OpenAI (Standard)
mercury config set voice.stt.provider openai
mercury config set voice.tts.provider openai

# Quelloffen, selbst gehostet, OpenAI-kompatibel — keine Codeänderung, nur eine baseUrl
mercury config set voice.stt.baseUrl http://localhost:8000/v1
mercury config set voice.tts.baseUrl http://localhost:8080/v1

# Vollständig offline, lokale CLIs
mercury config set voice.stt.provider whisper
mercury config set voice.tts.provider piper
mercury config set voice.tts.provider edge-tts
```
