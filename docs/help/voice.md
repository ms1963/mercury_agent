# Voice

Mercury transcribes voice input (web mic recordings, voice memos on chat platforms) and can
speak replies. Speech-to-text (STT) and text-to-speech (TTS) are **independently swappable**
between a commercial cloud API and an open-source / self-hosted server — a single config change,
no code edits.

## Named presets — one command (recommended)

The fastest way to exchange the STT/TTS solution (offline or online) is a named preset. Each
preset bundles the right `provider` / `baseUrl` / `command` / `model` keys for a known engine, so
you don't have to set them individually.

```sh
mercury voice presets              # list all STT and TTS presets with offline/online tags
mercury voice use stt whisper      # fully offline local CLI STT
mercury voice use tts kokoro       # self-hosted open-source TTS (Kokoro-FastAPI)
mercury voice use tts openai       # back to commercial OpenAI cloud TTS
mercury voice show                 # show the current voice configuration
```

`use` writes the **entire** `voice.stt` or `voice.tts` block in one declarative reconfiguration,
so no stale keys from the previous engine remain.

- **STT presets:** `openai` (online, commercial), `speaches` (offline, self-hosted
  faster-whisper), `whisper` (offline, local CLI).
- **TTS presets:** `openai` (online, commercial), `openedai` (offline, self-hosted),
  `kokoro` (offline, self-hosted), `piper` (offline, local CLI), `edge-tts` (online, free).

The individual keys below are still available for fine-tuning after applying a preset.

## Speech-to-text — `voice.stt.provider`

- `openai` (default) / `openai-compatible` — OpenAI-style `POST {baseUrl}/audio/transcriptions`.
  With the default `baseUrl` (`https://api.openai.com/v1`) this is the commercial Whisper API and
  needs a key in `OPENAI_API_KEY`. **Point `voice.stt.baseUrl` at a self-hosted server** that
  exposes the same route (e.g. faster-whisper-server, Speaches) to go fully open source — the key
  becomes optional for non-OpenAI hosts.
- `whisper` / `command` — local CLI (fully offline). Uses `voice.stt.command` (default
  `whisper {input} --model base --output_format txt --output_dir {outdir}`).
- `mock` — test-only; available only when `MERCURY_ENABLE_MOCK=1`.

Keys: `voice.stt.baseUrl`, `voice.stt.apiKeyEnv` (default `OPENAI_API_KEY`), `voice.stt.model`
(default `whisper-1`), `voice.stt.format`, `voice.stt.command`.

## Text-to-speech — `voice.tts.provider`

- `openai` (default) / `openai-compatible` — OpenAI-style `POST {baseUrl}/audio/speech`. Point
  `voice.tts.baseUrl` at a self-hosted server (e.g. openedai-speech, Kokoro-FastAPI) for an
  open-source swap.
- `piper` — offline neural TTS (MIT/Apache ecosystem), via `voice.tts.command`
  (default `piper --model {voice} --output_file {output}`, text on stdin).
- `edge-tts` — free Microsoft Edge voices (needs the `edge-tts` CLI).
- `command` — any custom CLI.
- `mock` — test-only; available only when `MERCURY_ENABLE_MOCK=1`.

Keys: `voice.tts.baseUrl`, `voice.tts.apiKeyEnv` (default `OPENAI_API_KEY`), `voice.tts.model`
(default `gpt-4o-mini-tts`), `voice.tts.voice` (default `alloy`), `voice.tts.format`
(default `mp3`), `voice.tts.command`.

## Switching (examples)

```sh
# Commercial OpenAI (default)
mercury config set voice.stt.provider openai
mercury config set voice.tts.provider openai

# Open source, self-hosted, OpenAI-compatible — zero code change, just a baseUrl
mercury config set voice.stt.baseUrl http://localhost:8000/v1
mercury config set voice.tts.baseUrl http://localhost:8080/v1

# Fully offline local CLIs
mercury config set voice.stt.provider whisper
mercury config set voice.tts.provider piper
mercury config set voice.tts.provider edge-tts
```
