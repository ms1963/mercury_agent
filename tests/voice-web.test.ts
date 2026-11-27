/**
 * Web voice helpers (packages/server/public/js/voice.js) — the hands-free, ChatLLM-style
 * voice mode for the browser chat UI. These cover the pure/injectable logic: markdown→speakable
 * text, UI-locale→speech-language mapping, voice selection, capability detection and
 * fallback-path selection, plus the speaker/listener wrappers driven by fake browser globals.
 * No real microphone, speaker or DOM is required — everything is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  speakableText,
  resolveSpeechLang,
  pickVoice,
  supportsSpeechSynthesis,
  supportsSpeechRecognition,
  recognitionCtor,
  chooseSpeakPath,
  chooseListenPath,
  createSpeaker,
  createRecognitionListener,
  // @ts-expect-error — plain ES module (not a typed package), imported by relative path.
} from '../packages/server/public/js/voice.js';

describe('speakableText', () => {
  it('strips inline code, bold and italics', () => {
    expect(speakableText('Use `npm run build` to **compile** the *app*.')).toBe('Use npm run build to compile the app.');
  });
  it('drops fenced code blocks entirely', () => {
    expect(speakableText('Here:\n```js\nconst x = 1;\n```\ndone')).toBe('Here: done');
  });
  it('keeps link labels, not URLs', () => {
    expect(speakableText('See [the docs](https://example.com/docs).')).toBe('See the docs.');
  });
  it('removes headings, bullets, numbered markers and blockquotes', () => {
    expect(speakableText('# Title\n- one\n- two\n1. three\n> quote')).toBe('Title one two three quote');
  });
  it('strips leftover HTML tags and collapses whitespace', () => {
    expect(speakableText('<p>hello   <br>world</p>')).toBe('hello world');
  });
  it('handles empty / nullish input', () => {
    expect(speakableText('')).toBe('');
    expect(speakableText(null)).toBe('');
    expect(speakableText(undefined)).toBe('');
  });
});

describe('resolveSpeechLang', () => {
  it('maps German variants to de-DE', () => {
    expect(resolveSpeechLang('de')).toBe('de-DE');
    expect(resolveSpeechLang('de-AT')).toBe('de-DE');
    expect(resolveSpeechLang('DE')).toBe('de-DE');
  });
  it('defaults everything else to en-US', () => {
    expect(resolveSpeechLang('en')).toBe('en-US');
    expect(resolveSpeechLang('fr')).toBe('en-US');
    expect(resolveSpeechLang(undefined)).toBe('en-US');
  });
});

describe('pickVoice', () => {
  const voices = [
    { lang: 'en-US', default: true },
    { lang: 'en-GB' },
    { lang: 'de-DE' },
    { lang: 'de-AT' },
  ];
  it('prefers an exact lang match', () => {
    expect(pickVoice(voices, 'de-DE')).toBe(voices[2]);
  });
  it('falls back to a language-prefix match', () => {
    expect(pickVoice(voices, 'de-CH')).toBe(voices[2]); // first de-*
  });
  it('falls back to the default voice when no language match', () => {
    expect(pickVoice([{ lang: 'es-ES' }, { lang: 'it-IT', default: true }], 'de-DE')).toEqual({ lang: 'it-IT', default: true });
  });
  it('returns null for an empty list', () => {
    expect(pickVoice([], 'en-US')).toBeNull();
    expect(pickVoice(undefined, 'en-US')).toBeNull();
  });
});

describe('capability detection', () => {
  it('detects speechSynthesis presence', () => {
    expect(supportsSpeechSynthesis({ speechSynthesis: {}, SpeechSynthesisUtterance: function () {} })).toBe(true);
    expect(supportsSpeechSynthesis({})).toBe(false);
    expect(supportsSpeechSynthesis({ speechSynthesis: {} })).toBe(false); // no utterance ctor
  });
  it('resolves the SpeechRecognition constructor (standard or webkit)', () => {
    const SR = function () {};
    expect(recognitionCtor({ SpeechRecognition: SR })).toBe(SR);
    expect(recognitionCtor({ webkitSpeechRecognition: SR })).toBe(SR);
    expect(recognitionCtor({})).toBeNull();
    expect(supportsSpeechRecognition({ webkitSpeechRecognition: SR })).toBe(true);
    expect(supportsSpeechRecognition({})).toBe(false);
  });
});

describe('fallback-path selection', () => {
  const withSynth = { speechSynthesis: {}, SpeechSynthesisUtterance: function () {} };
  const withRecog = { SpeechRecognition: function () {} };
  it('chooses browser when the native API exists', () => {
    expect(chooseSpeakPath(withSynth)).toBe('browser');
    expect(chooseListenPath(withRecog)).toBe('browser');
  });
  it('chooses server when only the fallback is available', () => {
    expect(chooseSpeakPath({}, true)).toBe('server');
    expect(chooseListenPath({}, true)).toBe('server');
  });
  it('chooses none when nothing is available', () => {
    expect(chooseSpeakPath({}, false)).toBe('none');
    expect(chooseListenPath({}, false)).toBe('none');
  });
});

describe('createSpeaker', () => {
  function fakeSynth() {
    const spoken: Array<{ text: string; lang: string }> = [];
    let cancelled = 0;
    const win = {
      speechSynthesis: {
        cancel: () => { cancelled++; },
        getVoices: () => [{ lang: 'de-DE' }, { lang: 'en-US', default: true }],
        speak: (u: { text: string; lang: string }) => spoken.push({ text: u.text, lang: u.lang }),
      },
      SpeechSynthesisUtterance: class { text: string; lang = ''; voice: unknown; constructor(t: string) { this.text = t; } },
    };
    return { win, spoken, cancelledCount: () => cancelled };
  }

  it('uses browser speechSynthesis with the resolved language', async () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ win: f.win as never, localeOf: () => 'de' });
    await speaker.speak('**Hallo** Welt');
    expect(f.spoken).toHaveLength(1);
    expect(f.spoken[0].text).toBe('Hallo Welt');
    expect(f.spoken[0].lang).toBe('de-DE');
  });

  it('does not speak empty/markdown-only text', async () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ win: f.win as never });
    await speaker.speak('``` ```');
    expect(f.spoken).toHaveLength(0);
  });

  it('falls back to serverSpeak when speechSynthesis is unavailable', async () => {
    const serverSpeak = vi.fn(async () => ({ pause() {} }));
    const speaker = createSpeaker({ win: {} as never, serverSpeak });
    await speaker.speak('Hello world');
    expect(serverSpeak).toHaveBeenCalledWith('Hello world');
  });

  it('cancel() stops browser speech', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ win: f.win as never });
    speaker.cancel();
    expect(f.cancelledCount()).toBe(1);
  });
});

describe('createRecognitionListener', () => {
  it('returns null when the recognition API is unavailable', () => {
    expect(createRecognitionListener({ win: {} as never })).toBeNull();
  });

  it('drives start → onState(listening) → onFinal → onState(idle)', () => {
    const instances: Array<Record<string, unknown>> = [];
    class FakeRec {
      lang = ''; interimResults = true; maxAlternatives = 0; continuous = true;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      started = false; stopped = false;
      constructor() { instances.push(this as unknown as Record<string, unknown>); }
      start() { this.started = true; }
      stop() { this.stopped = true; if (this.onend) this.onend(); }
    }
    const states: string[] = [];
    const finals: string[] = [];
    const listener = createRecognitionListener({
      win: { webkitSpeechRecognition: FakeRec } as never,
      localeOf: () => 'de',
      onState: (s: string) => states.push(s),
      onFinal: (t: string) => finals.push(t),
    });
    expect(listener).not.toBeNull();
    listener!.start();
    const rec = instances[0] as unknown as FakeRec;
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe('de-DE');
    expect(listener!.active).toBe(true);
    expect(states).toEqual(['listening']);
    // Simulate a final recognition result.
    rec.onresult!({ results: [[{ transcript: '  hallo welt  ' }]] });
    expect(finals).toEqual(['hallo welt']);
    // Stopping ends the session.
    listener!.stop();
    expect(rec.stopped).toBe(true);
    expect(states).toEqual(['listening', 'idle']);
    expect(listener!.active).toBe(false);
  });
});
