# Sprache

Mercury transkribiert Spracheingaben (Mikrofonaufnahmen im Web, Sprachnachrichten auf Chat-Plattformen) und kann
Antworten vorlesen.

- Sprache-zu-Text: `voice.stt.provider` = `mock` (Standard, gibt einen Platzhalter zurück), `openai`
  (Whisper-API, benötigt `OPENAI_API_KEY`), `whisper` oder `command` (lokale CLI via `voice.stt.command`).
- Text-zu-Sprache: `voice.tts.provider` = `mock` (Standard, kurzes stummes WAV), `openai`, `edge-tts`,
  `piper` oder `command`.

Beispiel: `mercury config set voice.stt.provider openai`.
