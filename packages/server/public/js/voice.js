/**
 * Hands-free voice helpers for the web chat UI (ChatLLM-style).
 *
 * Progressive enhancement: the browser's native Web Speech APIs are the primary path
 * (instant, no server round-trip, works without the server-side piper/whisper models),
 * and the existing server endpoints (/api/voice/speak, /api/voice/transcribe) are the
 * graceful fallback. Nothing here hard-fails: if neither path is available the caller
 * degrades quietly and text chat keeps working.
 *
 * The pure helpers (speakableText, resolveSpeechLang, pickVoice, choose*Path) take all
 * their inputs as arguments / an injectable `win`, so they are unit-testable without a
 * real browser, microphone or speaker.
 */

// ---- pure helpers -----------------------------------------------------------

/**
 * Strip Markdown / HTML down to plain, speakable text. Intentionally simple — the goal
 * is "readable aloud", not perfect rendering. Removes code fences, inline code, emphasis
 * markers, link syntax (keeping the label), headings, list bullets, blockquotes and any
 * leftover HTML tags, then collapses whitespace.
 */
export function speakableText(src) {
  let s = String(src ?? '');
  // Fenced code blocks -> drop entirely (reading code aloud is noise).
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Inline code -> keep the content without backticks.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Images ![alt](url) -> alt text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links [label](url) -> label.
  s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  // Bold / italic markers.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1');
  // Headings, list bullets and blockquotes at line starts.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  // Any leftover HTML tags.
  s = s.replace(/<[^>]+>/g, ' ');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Map a UI locale (e.g. 'en', 'de', 'de-AT') to a BCP-47 speech language tag used by both
 * SpeechSynthesis and SpeechRecognition. German -> 'de-DE', everything else -> 'en-US'.
 */
export function resolveSpeechLang(locale) {
  const l = String(locale ?? '').toLowerCase();
  if (l === 'de' || l.startsWith('de-') || l.startsWith('de_')) return 'de-DE';
  return 'en-US';
}

/**
 * Choose the best available SpeechSynthesisVoice for a BCP-47 lang tag.
 * Prefers an exact (case-insensitive) match, then a language-prefix match (e.g. 'de'),
 * then a voice flagged `default`, else the first available, else null.
 */
export function pickVoice(voices, lang) {
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) return null;
  const want = String(lang ?? '').toLowerCase();
  const prefix = want.split('-')[0];
  const exact = list.find((v) => String(v.lang ?? '').toLowerCase() === want);
  if (exact) return exact;
  const byPrefix = list.find((v) => String(v.lang ?? '').toLowerCase().split('-')[0] === prefix);
  if (byPrefix) return byPrefix;
  return list.find((v) => v.default) ?? list[0];
}

// ---- capability detection ---------------------------------------------------

export function supportsSpeechSynthesis(win = globalThis) {
  return !!(win && win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function');
}

/** Return the SpeechRecognition constructor (standard or webkit-prefixed), or null. */
export function recognitionCtor(win = globalThis) {
  if (!win) return null;
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function supportsSpeechRecognition(win = globalThis) {
  return !!recognitionCtor(win);
}

/**
 * Decide which read-aloud path to use. 'browser' when speechSynthesis is present,
 * else 'server' when a server-TTS fallback was supplied, else 'none'.
 */
export function chooseSpeakPath(win = globalThis, hasServerFallback = true) {
  if (supportsSpeechSynthesis(win)) return 'browser';
  return hasServerFallback ? 'server' : 'none';
}

/**
 * Decide which speech-to-text path to use. 'browser' when the Web Speech recognition API
 * is present, else 'server' when a server-STT fallback was supplied, else 'none'.
 */
export function chooseListenPath(win = globalThis, hasServerFallback = true) {
  if (supportsSpeechRecognition(win)) return 'browser';
  return hasServerFallback ? 'server' : 'none';
}

// ---- speaker (text -> speech) ----------------------------------------------

/**
 * Create a speaker that reads text aloud. Uses window.speechSynthesis when available,
 * otherwise falls back to the injected `serverSpeak(text)` (which should perform the
 * POST /api/voice/speak round-trip and play the audio).
 *
 * @param {object} opts
 * @param {Window} [opts.win]            Injectable window (for tests).
 * @param {(text:string)=>Promise<void>} [opts.serverSpeak]  Server-TTS fallback.
 * @param {()=>string} [opts.localeOf]   Returns the current UI locale.
 */
export function createSpeaker({ win = globalThis, serverSpeak, localeOf } = {}) {
  const current = { audio: null };
  return {
    /** Speak `text`. Cancels any in-progress speech first. */
    async speak(text, { lang } = {}) {
      const clean = speakableText(text);
      if (!clean) return;
      const speechLang = lang || resolveSpeechLang(localeOf ? localeOf() : undefined);
      if (supportsSpeechSynthesis(win)) {
        win.speechSynthesis.cancel();
        const u = new win.SpeechSynthesisUtterance(clean);
        u.lang = speechLang;
        const voices = win.speechSynthesis.getVoices ? win.speechSynthesis.getVoices() : [];
        const v = pickVoice(voices, speechLang);
        if (v) u.voice = v;
        win.speechSynthesis.speak(u);
        return;
      }
      if (serverSpeak) {
        this.cancel();
        current.audio = await serverSpeak(clean);
      }
    },
    /** Stop any in-progress speech (browser utterance or fallback audio). */
    cancel() {
      if (supportsSpeechSynthesis(win)) win.speechSynthesis.cancel();
      if (current.audio && typeof current.audio.pause === 'function') {
        try { current.audio.pause(); } catch { /* ignore */ }
        current.audio = null;
      }
    },
  };
}

// ---- listener (speech -> text) ---------------------------------------------

/**
 * Create a listener for browser-native speech-to-text using the Web Speech recognition API.
 * Returns null when the API is unavailable (caller should use the MediaRecorder fallback).
 *
 * @param {object} opts
 * @param {Window} [opts.win]
 * @param {()=>string} [opts.localeOf]
 * @param {(state:'listening'|'idle'|'error')=>void} [opts.onState]
 * @param {(text:string)=>void} [opts.onFinal]
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createRecognitionListener({ win = globalThis, localeOf, onState, onFinal, onError } = {}) {
  const Ctor = recognitionCtor(win);
  if (!Ctor) return null;
  let rec = null;
  return {
    get active() { return !!rec; },
    start() {
      if (rec) return;
      rec = new Ctor();
      rec.lang = resolveSpeechLang(localeOf ? localeOf() : undefined);
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      rec.onresult = (e) => {
        const res = e.results && e.results[0] && e.results[0][0];
        const text = res && res.transcript ? String(res.transcript).trim() : '';
        if (text && onFinal) onFinal(text);
      };
      rec.onerror = (e) => { if (onError) onError(e && e.error ? String(e.error) : 'speech-error'); };
      rec.onend = () => { rec = null; if (onState) onState('idle'); };
      rec.start();
      if (onState) onState('listening');
    },
    stop() {
      if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    },
  };
}
