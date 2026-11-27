/** Chat panel: streaming replies, tool/subagent chips, approvals, attachments, mic, audio playback, feedback. */
import { api, esc, h, markdown, safe, state, stream, t, toast } from './core.js';
import { createRecognitionListener, createSpeaker, supportsSpeechRecognition } from './voice.js';

const chat = { sessionId: localStorage.getItem('mercury.session') || undefined, attachments: [], running: null, recorder: null, listener: null };

// Hands-free voice state, persisted so the choice survives reloads (opt-in: both default OFF).
const voicePrefs = {
  get autospeak() { return localStorage.getItem('mercury.voice.autospeak') === '1'; },
  set autospeak(on) { localStorage.setItem('mercury.voice.autospeak', on ? '1' : '0'); },
  get autosend() { return localStorage.getItem('mercury.voice.autosend') === '1'; },
  set autosend(on) { localStorage.setItem('mercury.voice.autosend', on ? '1' : '0'); },
};

/** Server-TTS fallback: POST /api/voice/speak and play the returned audio, returning the Audio element. */
async function serverSpeak(text) {
  const res = await api('/api/voice/speak', { body: { text: text.slice(0, 4000) }, raw: true });
  const audio = new Audio(URL.createObjectURL(await res.blob()));
  audio.play();
  return audio;
}

// Shared speaker: browser speechSynthesis primary, server /api/voice/speak fallback.
const speaker = createSpeaker({ serverSpeak, localeOf: () => state.locale });

function setSession(id) {
  chat.sessionId = id || undefined;
  if (id) localStorage.setItem('mercury.session', id);
  else localStorage.removeItem('mercury.session');
}
export const openSession = (id) => setSession(id);

function bubble(role, text) {
  const body = h('div.body', { html: markdown(text) });
  const meta = h('div.meta');
  const extra = h('div.extra');
  const el = h(`div.msg.${role}`, {}, extra, body, meta);
  return { el, body, meta, extra };
}

function playButton(text) {
  return h('button.ghost', {
    title: t('chat.speak'),
    onclick: safe(() => speaker.speak(text)),
  }, '🔊');
}

function feedbackButtons(runId) {
  const send = (positive) => safe(async () => (await api(`/api/runs/${runId}/feedback`, { body: { positive } }), toast(t('common.saved'))));
  return [h('button.ghost', { title: t('chat.good'), onclick: send(true) }, '👍'), h('button.ghost', { title: t('chat.bad'), onclick: send(false) }, '👎')];
}

function approvalCard(d) {
  const card = h('div.approval', {}, h('strong', {}, `${t('chat.approvalNeeded')}: ${d.title}`), h('div.small', {}, d.detail));
  const resolve = (approved) => safe(async () => {
    await api(`/api/approvals/${d.id}`, { body: { approved } });
    card.replaceChildren(h('span.small', {}, `${d.title}: ${approved ? '✔' : '✖'}`));
  });
  card.append(h('div.row', {}, h('button.primary', { onclick: resolve(true) }, t('chat.approve')), h('button', { onclick: resolve(false) }, t('chat.deny'))));
  return card;
}

/** Render one streamed bus event into the current reply bubble. */
function showEvent(b, e, rootRun) {
  const d = e.data || {};
  const sub = e.runId !== rootRun ? '↳ ' : '';
  if (e.type === 'tool.call') b.extra.append(h('span.chip', { title: d.args }, `${sub}⚙ ${d.name}`));
  else if (e.type === 'tool.result' && !d.ok) b.extra.append(h('span.chip.error', {}, `${sub}✖ ${d.name}`));
  else if (e.type === 'tool.denied') b.extra.append(h('span.chip.error', {}, `${sub}⛔ ${d.name}`));
  else if (e.type === 'subagent.spawn') b.extra.append(h('span.chip', {}, `🤖 ${d.name || d.agent || 'subagent'}`));
  else if (e.type === 'guardrail') b.extra.append(h('span.chip', { title: JSON.stringify(d) }, `🛡 ${d.kind || d.rule || 'guardrail'}`));
  else if (e.type === 'approval.request') b.extra.append(approvalCard(d));
  else if (e.type === 'debug.paused') b.extra.append(h('span.chip', {}, `⏸ ${d.kind} (Observability → resume)`));
}

async function send(ui, text) {
  if (!text.trim() || chat.running) return;
  const opts = Object.fromEntries(['model', 'pattern', 'personality'].map((k) => [k, ui[k].value || undefined]));
  const userB = bubble('user', text);
  if (chat.attachments.length) userB.meta.append(...chat.attachments.map((a) => h('span.chip', {}, `📎 ${a.name}`)));
  ui.messages.append(userB.el);
  const b = bubble('assistant', `_${t('chat.thinking')}_`);
  ui.messages.append(b.el);
  ui.messages.scrollTop = ui.messages.scrollHeight;
  const controller = new AbortController();
  chat.running = { controller, runId: null };
  ui.setBusy(true);
  let out = '';
  let rootRun = null;
  const attachments = chat.attachments.map((a) => a.id);
  chat.attachments = [];
  ui.renderAttachments();
  try {
    await stream('/api/chat', { message: text, stream: true, sessionId: chat.sessionId, attachments, ...opts }, (type, d) => {
      if (type === 'delta') {
        out += d.text;
        b.body.innerHTML = markdown(out);
      } else if (type === 'event') {
        if (d.type === 'run.start' && !rootRun) chat.running.runId = rootRun = d.runId;
        showEvent(b, d, rootRun);
      } else if (type === 'done') {
        setSession(d.sessionId);
        b.body.innerHTML = markdown(d.output || out);
        if (d.usage) b.meta.append(h('span', {}, `${d.model ?? ''} · ${d.pattern ?? ''} · ${d.usage.inputTokens + d.usage.outputTokens} tok · $${(d.usage.cost ?? 0).toFixed(4)}`));
        b.meta.append(playButton(d.output || out));
        if (d.runId) b.meta.append(...feedbackButtons(d.runId));
        if (voicePrefs.autospeak) safe(() => speaker.speak(d.output || out))();
      } else if (type === 'error') b.body.innerHTML = `<span class="error">${esc(t('common.error'))}: ${esc(d.error)}</span>`;
      ui.messages.scrollTop = ui.messages.scrollHeight;
    }, controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') b.body.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    chat.running = null;
    ui.setBusy(false);
  }
}

async function loadHistory(ui) {
  if (!chat.sessionId) return;
  const r = await api(`/api/sessions/${chat.sessionId}`).catch(() => null);
  if (!r) return setSession(undefined);
  for (const m of r.messages) {
    const b = bubble(m.role, m.content);
    if (m.role === 'assistant') b.meta.append(playButton(m.content));
    ui.messages.append(b.el);
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

/** Submit a message through the same path the Send button uses (so auto-send is identical to a click). */
function submit(ui, text) {
  if (!text || !text.trim() || chat.running) return;
  ui.input.value = '';
  send(ui, text);
}

/** Handle a finished transcription: drop into the input, and auto-send hands-free when enabled. */
function onTranscript(ui, text) {
  const clean = (text || '').trim();
  if (!clean) return;
  if (voicePrefs.autosend) {
    submit(ui, clean);
  } else {
    ui.input.value = (ui.input.value ? ui.input.value + ' ' : '') + clean;
    ui.input.focus();
  }
}

/** Show/clear the "listening…" state on the mic button. */
function setMicState(ui, listening) {
  ui.mic.textContent = listening ? '🔴' : '🎤';
  ui.mic.title = listening ? t('chat.listening') : t('chat.record');
  ui.mic.classList.toggle('listening', !!listening);
}

/** Primary path: browser-native speech-to-text via the Web Speech recognition API. */
function toggleRecognition(ui) {
  if (chat.listener?.active) return chat.listener.stop();
  chat.listener = createRecognitionListener({
    localeOf: () => state.locale,
    onState: (s) => setMicState(ui, s === 'listening'),
    onFinal: (text) => onTranscript(ui, text),
    onError: (msg) => { setMicState(ui, false); if (msg !== 'no-speech' && msg !== 'aborted') toast(msg, true); },
  });
  chat.listener.start();
}

/** Fallback path: record audio and POST to the server whisper endpoint. */
async function toggleRecording(ui) {
  if (chat.recorder) return chat.recorder.stop();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone not available in this browser (HTTPS required).');
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(media);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = safe(async () => {
    media.getTracks().forEach((tr) => tr.stop());
    chat.recorder = null;
    setMicState(ui, false);
    ui.input.placeholder = t('chat.transcribing');
    try {
      const r = await api('/api/voice/transcribe', { body: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) });
      onTranscript(ui, r.text);
    } finally {
      ui.input.placeholder = t('chat.placeholder');
    }
  });
  rec.start();
  chat.recorder = rec;
  setMicState(ui, true);
}

/** Mic entry point: prefer browser-native recognition, fall back to MediaRecorder + server whisper. */
function micClick(ui) {
  if (supportsSpeechRecognition()) return toggleRecognition(ui);
  return toggleRecording(ui);
}

export async function renderChat(view) {
  const models = await api('/api/models').catch(() => ({ providers: [], patterns: [], personalities: [] }));
  const select = (items, label) => h('select', { title: label }, h('option', { value: '' }, `${label}: ${t('chat.default')}`), items.map((v) => h('option', { value: v.name ?? v }, v.title ?? v.name ?? v)));
  const modelOpts = [...new Set([models.defaultModel, ...(models.profiles || []).map((p) => p.id ?? p.name ?? p), ...models.providers.map((p) => `${p}/`)].filter((x) => typeof x === 'string' && !x.endsWith('/')))];
  const ui = {
    messages: h('div.messages'),
    input: h('textarea', { placeholder: t('chat.placeholder'), rows: 3 }),
    model: select(modelOpts, t('chat.model')),
    pattern: select(models.patterns || [], t('chat.pattern')),
    personality: select(models.personalities || [], t('chat.personality')),
    attachList: h('div.attachments'),
    file: h('input', { type: 'file', multiple: true, hidden: true }),
    mic: h('button', { title: t('chat.record') }, '🎤'),
    readAloud: h('button.ghost', {}, '🔇'),
    autoSend: h('button.ghost', {}, '🖐'),
    sendBtn: h('button.primary', {}, t('chat.send')),
    stopBtn: h('button.danger.hidden', {}, t('chat.stop')),
  };
  ui.setBusy = (busy) => (ui.sendBtn.classList.toggle('hidden', busy), ui.stopBtn.classList.toggle('hidden', !busy));
  // Read-aloud toggle: speak every assistant reply automatically. Off cancels any in-progress speech.
  ui.renderReadAloud = () => {
    const on = voicePrefs.autospeak;
    ui.readAloud.textContent = on ? '🔊' : '🔇';
    ui.readAloud.classList.toggle('active', on);
    ui.readAloud.title = `${t('chat.readAloud')}: ${on ? t('chat.readAloudOn') : t('chat.readAloudOff')}`;
  };
  ui.readAloud.onclick = () => {
    voicePrefs.autospeak = !voicePrefs.autospeak;
    if (!voicePrefs.autospeak) speaker.cancel();
    ui.renderReadAloud();
  };
  ui.renderReadAloud();
  // Auto-send toggle: after a voice transcription, send hands-free instead of just filling the box.
  ui.renderAutoSend = () => {
    const on = voicePrefs.autosend;
    ui.autoSend.textContent = on ? '🗣' : '🖐';
    ui.autoSend.classList.toggle('active', on);
    ui.autoSend.title = `${t('chat.autoSend')}: ${on ? t('chat.autoSendOn') : t('chat.autoSendOff')}`;
  };
  ui.autoSend.onclick = () => { voicePrefs.autosend = !voicePrefs.autosend; ui.renderAutoSend(); };
  ui.renderAutoSend();
  ui.renderAttachments = () => ui.attachList.replaceChildren(...chat.attachments.map((a, i) => h('span.chip', {}, `📎 ${a.name}`, h('button', { onclick: () => (chat.attachments.splice(i, 1), ui.renderAttachments()) }, '×'))));
  ui.file.onchange = safe(async () => {
    for (const f of ui.file.files) chat.attachments.push(await api(`/api/attachments?name=${encodeURIComponent(f.name)}`, { body: f }));
    ui.file.value = '';
    ui.renderAttachments();
  });
  ui.mic.onclick = safe(() => micClick(ui));
  ui.sendBtn.onclick = () => {
    const text = ui.input.value;
    ui.input.value = '';
    send(ui, text);
  };
  ui.stopBtn.onclick = safe(async () => {
    const r = chat.running;
    if (r?.runId) await api(`/api/runs/${r.runId}/stop`, { body: {} });
    r?.controller.abort();
  });
  ui.input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), ui.sendBtn.click());
  };
  const newBtn = h('button', { onclick: () => (setSession(undefined), ui.messages.replaceChildren()) }, t('chat.newSession'));
  view.append(
    h('div.chat', {},
      h('div.row', {}, h('h2.grow', {}, t('nav.chat')), ui.readAloud, ui.autoSend, ui.model, ui.pattern, ui.personality, newBtn),
      ui.messages,
      h('div.composer', {}, ui.attachList, ui.input, h('div.row', {}, h('button', { onclick: () => ui.file.click() }, `📎 ${t('chat.attach')}`), ui.file, ui.mic, h('span.grow'), h('span.small.muted', {}, state.user?.username ?? ''), ui.stopBtn, ui.sendBtn))));
  await loadHistory(ui);
  ui.input.focus();
}
