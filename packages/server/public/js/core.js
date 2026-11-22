/** Shared helpers: REST client, SSE-over-fetch, i18n, DOM building, toasts, tiny Markdown. */

export const state = { token: localStorage.getItem('mercury.token') || '', user: null, catalog: {}, locale: localStorage.getItem('mercury.locale') || 'en' };

export function setToken(token) {
  state.token = token || '';
  if (token) localStorage.setItem('mercury.token', token);
  else localStorage.removeItem('mercury.token');
}

/** JSON API call. `body` may be an object (JSON), a Blob/File (raw upload) or undefined. */
export async function api(path, { method, body, raw = false } = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['content-type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: payload });
  if (res.status === 401 && state.token) {
    setToken('');
    location.reload();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || `HTTP ${res.status}`);
  }
  if (raw) return res;
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

/** POST and read a server-sent-event stream; calls onEvent(type, data) per event. */
export async function stream(path, body, onEvent, signal) {
  const res = await fetch(path, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const type = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (type && data) onEvent(type, JSON.parse(data));
    }
  }
}

// ---- i18n -----------------------------------------------------------------
export async function loadLocale(locale) {
  state.locale = locale;
  localStorage.setItem('mercury.locale', locale);
  state.catalog = await api(`/api/i18n/${locale}`).catch(() => ({}));
  document.documentElement.lang = locale;
  translate(document);
}
export function t(key, fallback) {
  const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), state.catalog);
  return typeof v === 'string' ? v : fallback ?? key.split('.').pop();
}
export function translate(root) {
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n, el.textContent)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
}

// ---- DOM --------------------------------------------------------------------
/** h('button.primary', { onclick }, 'text', child, ...) */
export function h(sel, attrs = {}, ...children) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = isError ? 'var(--danger)' : '';
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4000);
}

/** Wrap an async UI action: show errors as toasts. */
export const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    toast(err.message, true);
  }
};

/** Generic table: cols = [[header, row => value|Node], ...]. */
export function table(rows, cols) {
  if (!rows?.length) return h('p.muted', {}, t('common.empty'));
  return h('table', {}, h('thead', {}, h('tr', {}, cols.map(([c]) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, cols.map(([, f]) => h('td', {}, f(r) ?? ''))))));
}

export const badge = (on, yes = 'on', no = 'off') => h(`span.badge.${on ? 'on' : 'off'}`, {}, on ? yes : no);
export const json = (v) => h('pre', {}, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Minimal, safe Markdown: code blocks, inline code, bold, italics, links, lists, paragraphs. */
export function markdown(src) {
  const blocks = String(src ?? '').split(/```/);
  return blocks
    .map((part, i) => {
      if (i % 2) return `<pre><code>${esc(part.replace(/^\w*\n/, ''))}</code></pre>`;
      return esc(part)
        .split(/\n{2,}/)
        .map((p) => {
          let html = p
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/^#{1,6} (.*)$/gm, '<strong>$1</strong>');
          if (/^\s*[-*] /m.test(html)) html = html.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>[\s\S]*<\/li>)/, '<ul>$1</ul>');
          return html.trim() ? `<p>${html.replace(/\n(?!<)/g, '<br>')}</p>` : '';
        })
        .join('');
    })
    .join('');
}
