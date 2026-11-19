/**
 * Voice ports: small, swappable interfaces for speech-to-text (STT) and text-to-speech (TTS).
 *
 * This mirrors the LLM design (LLMPort + a config-driven registry): each concrete port talks to
 * exactly one backend, and a factory builds the right one from `config.voice.*`. Swapping between a
 * commercial cloud API and a self-hosted open-source server is therefore a pure config change —
 * no code edits (see ./factory.ts and ./providers/*).
 */

/** Result of a text-to-speech synthesis: a file on disk plus its MIME type. */
export interface SpeechResult {
  path: string;
  mime: string;
}

/** Speech-to-text port. Transcribes an audio file to text. */
export interface SttPort {
  /** Provider id this port was built for (e.g. 'openai', 'whisper', 'mock'). */
  readonly provider: string;
  transcribe(path: string, mime: string): Promise<string>;
}

/** Text-to-speech port. Synthesizes speech and writes it to disk. */
export interface TtsPort {
  /** Provider id this port was built for (e.g. 'openai', 'piper', 'mock'). */
  readonly provider: string;
  speak(text: string, voice?: string): Promise<SpeechResult>;
}
