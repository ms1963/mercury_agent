/** Mercury web UI entry: auth screen, navigation, hash router, theme and language switching. */
import { api, h, loadLocale, safe, setToken, state, t, translate } from './core.js';
import { renderChat } from './chat.js';
import { renderMemory, renderRuns, renderSessions, renderSkills, renderTools, renderWorkflows } from './panels-work.js';
import { renderAccount, renderDebug, renderGovernance, renderHelp, renderIntegrations, renderModels, renderProactive, renderReflections, renderReliability, renderScheduler, renderUsers, renderVerification, stopDebug } from './panels-admin.js';

const PANELS = {
  chat: renderChat, sessions: renderSessions, runs: renderRuns, workflows: renderWorkflows, memory: renderMemory, skills: renderSkills,
  tools: renderTools, scheduler: renderScheduler, integrations: renderIntegrations, models: renderModels,
  verification: renderVerification, reliability: renderReliability, proactive: renderProactive,
  governance: renderGovernance, users: renderUsers, debug: renderDebug, reflections: renderReflections, help: renderHelp, account: renderAccount,
};
const ADMIN_ONLY = new Set(['users', 'governance', 'verification', 'reliability', 'proactive']);
const $ = (id) => document.getElementById(id);

function go(name) {
  location.hash = name;
}

async function route() {
  const name = location.hash.slice(1) || 'chat';
  const render = PANELS[name] ?? renderChat;
  if (name !== 'debug') stopDebug();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.panel === name));
  const view = $('view');
  view.replaceChildren();
  await safe(render)(view, go);
}

function buildNav() {
  $('nav').replaceChildren(...Object.keys(PANELS)
    .filter((p) => !ADMIN_ONLY.has(p) || state.user?.role === 'admin')
    .map((p) => h('a', { href: `#${p}`, 'data-panel': p }, t(`nav.${p}`))));
}

async function showShell() {
  const me = await api('/api/auth/me');
  state.user = me.user;
  $('auth').classList.add('hidden');
  $('shell').classList.remove('hidden');
  $('whoami').textContent = `${me.user.username} (${me.user.role})`;
  buildNav();
  await route();
}

async function showAuth() {
  const status = await api('/api/auth/status');
  let mode = status.users === 0 ? 'register' : 'login';
  const form = $('auth-form');
  const apply = () => {
    $('auth-submit').textContent = t(mode === 'login' ? 'auth.login' : 'auth.register');
    $('auth-switch').textContent = t(mode === 'login' ? 'auth.switchToRegister' : 'auth.switchToLogin');
    $('auth-switch').classList.toggle('hidden', !status.allowRegistration);
    $('auth-hint').classList.toggle('hidden', status.users !== 0);
  };
  $('auth-switch').onclick = (e) => (e.preventDefault(), (mode = mode === 'login' ? 'register' : 'login'), apply());
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    try {
      const r = await api(`/api/auth/${mode}`, { body: { username: form.username.value, password: form.password.value } });
      setToken(r.token);
      await showShell();
    } catch (err) {
      $('auth-error').textContent = `${t('auth.failed')}: ${err.message}`;
    }
  };
  $('auth').classList.remove('hidden');
  apply();
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('mercury.theme', theme);
}

async function init() {
  setTheme(localStorage.getItem('mercury.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const { locales } = await api('/api/i18n');
  const sel = $('locale');
  sel.replaceChildren(...locales.map((l) => h('option', { value: l, selected: l === state.locale }, l.toUpperCase())));
  sel.onchange = async () => {
    await loadLocale(sel.value);
    if (state.user) (buildNav(), route());
  };
  await loadLocale(locales.includes(state.locale) ? state.locale : 'en');
  translate(document);
  $('logout').onclick = () => (setToken(''), location.reload());
  window.addEventListener('hashchange', route);
  if (state.token) {
    try {
      return await showShell();
    } catch {
      setToken('');
    }
  }
  await showAuth();
}

init();
