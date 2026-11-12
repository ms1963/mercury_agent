# Voice

Mercury transcribes voice input (web mic recordings, voice memos on chat platforms) and can
speak replies.

- Speech-to-text: `voice.stt.provider` = `mock` (default, returns a placeholder), `openai`
  (Whisper API, needs `OPENAI_API_KEY`), `whisper` or `command` (local CLI via `voice.stt.command`).
- Text-to-speech: `voice.tts.provider` = `mock` (default, short silent WAV), `openai`, `edge-tts`,
  `piper` or `command`.

Example: `mercury config set voice.stt.provider openai`.
