/** Panels: scheduler, integrations, models/router/budgets/Jev, users, observability/debug, reflections, help, account. */
import { api, badge, h, json, markdown, safe, state, t, table, toast, when } from './core.js';

const field = (placeholder, attrs = {}) => h('input', { placeholder, ...attrs });
const card = (title, ...children) => h('div.card', {}, title ? h('h3', {}, title) : null, ...children);
const isAdmin = () => state.user?.role === 'admin';

/** Re-render helper: build(container) is re-run by reload(). */
async function panel(view, title, build) {
  const body = h('div');
  const reload = safe(async () => body.replaceChildren(...[await build(reload)].flat()));
  view.append(h('div.row', {}, h('h2.grow', {}, title), h('button', { onclick: reload }, t('common.refresh'))), body);
  await reload();
}

export const renderScheduler = (view) => panel(view, t('scheduler.title'), async (reload) => {
  const r = await api('/api/schedules');
  const whenIn = field(t('scheduler.when'), { className: 'grow' });
  const task = field(t('scheduler.task'), { className: 'grow' });
  const history = h('div');
  const act = (s, a) => safe(async () => (await api(`/api/schedules/${s.id}/${a}`, { body: {} }), reload()));
  const showHistory = async (s) =>
    history.replaceChildren(card(`${t('scheduler.history')}: ${s.name}`, json((await api(`/api/schedules/${s.id}/history`)).runs)));
  // Run now returns immediately (the run executes in the background), so give the user
  // explicit feedback: a toast plus the schedule's history, which shows the "running" entry.
  const runNow = (s) => safe(async () => {
    await api(`/api/schedules/${s.id}/run`, { body: {} });
    toast(t('scheduler.runStarted', 'Run started — see History'));
    await showHistory(s);
    await reload();
  });
  return [
    card(null, table(r.schedules, [
      [t('common.name'), (s) => s.name], ['When', (s) => s.nl || s.spec], [t('scheduler.task'), (s) => h('span.small', {}, s.task)],
      [t('common.status'), (s) => badge(s.status === 'active', s.status, s.status)], [t('scheduler.next'), (s) => when(s.nextRun)],
      [t('common.actions'), (s) => h('span', {},
        s.status === 'active' ? h('button', { onclick: act(s, 'pause') }, t('common.pause')) : h('button', { onclick: act(s, 'resume') }, t('common.resume')),
        h('button', { onclick: runNow(s) }, t('scheduler.runNow')),
        h('button', { onclick: safe(() => showHistory(s)) }, t('scheduler.history')),
        h('button.danger', { onclick: safe(async () => confirm(t('common.confirmDelete')) && (await api(`/api/schedules/${s.id}`, { method: 'DELETE' }), reload())) }, '×'))],
    ])),
    card(t('common.create'), h('div.row', {}, whenIn, task, h('button.primary', { onclick: safe(async () => (await api('/api/schedules', { body: { when: whenIn.value, task: task.value, delivery: { platform: 'web' } } }), reload())) }, t('common.create')))),
    history,
  ];
});

export const renderIntegrations = (view) => panel(view, t('integrations.title'), async (reload) => {
  const r = await api('/api/gateway');
  const code = field('ABC123');
  return [
    card(t('integrations.adapters'), r.enabled ? null : h('p.muted', {}, 'gateway.enabled = false — set it in config to start adapters.'),
      table(r.adapters, [[t('common.name'), (a) => a.name], ['Type', (a) => a.type], [t('common.status'), (a) => badge(a.status.connected, 'connected', 'offline')], ['Detail', (a) => h('span.small', {}, a.status.error || a.status.detail || '')], ['Last activity', (a) => when(a.status.lastActivity)]]),
      h('p.small.muted', {}, 'Webhook URL pattern: ', h('code', {}, `${location.origin}/webhooks/<adapter>`))),
    card(t('integrations.pairCode'), h('div.row', {}, code, h('button.primary', { onclick: safe(async () => (await api(`/api/gateway/pair/${code.value.trim()}`, { body: {} }), toast(t('common.saved')), reload())) }, t('integrations.pairCode')))),
    card(t('integrations.identities'), table(r.identities, [['Platform', (i) => i.platform], ['External id', (i) => i.externalId ?? i.external_id], ['Name', (i) => i.displayName ?? i.display_name]])),
    isAdmin() ? card(t('integrations.pairing'), table(r.pairing, [['Code', (p) => h('code', {}, p.code)], ['Platform', (p) => p.platform], ['User', (p) => p.displayName || p.externalId], ['Created', (p) => when(p.createdAt)],
      ['', (p) => h('span', {}, h('button.primary', { onclick: safe(async () => (await api(`/api/gateway/pair/${p.code}`, { body: {} }), reload())) }, 'Link to me'), h('button.danger', { onclick: safe(async () => (await api(`/api/gateway/pair/${p.code}`, { body: { reject: true } }), reload())) }, '×'))]])) : null,
    isAdmin() ? card(t('integrations.review'), table(r.review, [['Platform', (x) => x.item?.platform], ['Message', (x) => h('span.small', {}, x.item?.text)], ['Jev', (x) => h('span.small', {}, JSON.stringify(x.decision?.answers ?? x.decision ?? '').slice(0, 200))],
      ['', (x) => h('span', {}, ...['respond', 'dismiss'].map((action) => h('button', { onclick: safe(async () => (await api(`/api/gateway/review/${x.id}`, { body: { action } }), reload())) }, t(`integrations.${action}`))))]])) : null,
  ];
});

export const renderModels = (view) => panel(view, t('models.title'), async (reload) => {
  const [m, b, d] = await Promise.all([api('/api/models'), api('/api/budgets'), api('/api/decisions')]);
  const task = field(t('models.route'), { className: 'grow' });
  const routeOut = h('div');
  const budget = { user: field('user id or *', { value: '*' }), model: field('model or *', { value: '*' }), period: h('select', {}, h('option', {}, 'daily'), h('option', {}, 'monthly')), maxCost: field('max cost $', { type: 'number', step: '0.01' }), maxTokens: field('max tokens', { type: 'number' }) };
  const state = field('state (text)', { className: 'grow' });
  const tryOut = h('div');
  return [
    card(t('models.default'), h('p', {}, h('code', {}, m.defaultModel), ` · ${t('models.providers')}: ${m.providers.join(', ')}`),
      table(m.profiles, [['Model', (p) => h('code', {}, p.id)], ['Quality', (p) => p.quality], ['Tags', (p) => p.tags.join(', ')], ['Context', (p) => p.contextWindow], ['$ in/out per 1M', (p) => `${p.costPer1MInput} / ${p.costPer1MOutput}`], [t('common.status'), (p) => badge(p.enabled)]])),
    card(t('models.route'), h('div.row', {}, task, h('button.primary', { onclick: safe(async () => routeOut.replaceChildren(json(await api('/api/models/route', { body: { task: task.value } })))) }, t('common.run'))), routeOut),
    card(t('models.budgets'), table(b.rules, [['User', (r) => r.user], ['Model', (r) => r.model], ['Period', (r) => r.period], ['Max $', (r) => r.maxCost ?? ''], ['Max tokens', (r) => r.maxTokens ?? ''],
      ['', (r) => (String(r.id).startsWith('config_') ? h('span.small.muted', {}, 'config') : h('button.danger', { onclick: safe(async () => (await api(`/api/budgets/${r.id}`, { method: 'DELETE' }), reload())) }, '×'))]]),
      isAdmin() ? h('div.row', {}, ...Object.values(budget), h('button.primary', { onclick: safe(async () => (await api('/api/budgets', { body: { user: budget.user.value, model: budget.model.value, period: budget.period.value, maxCost: budget.maxCost.value ? Number(budget.maxCost.value) : undefined, maxTokens: budget.maxTokens.value ? Number(budget.maxTokens.value) : undefined } }), reload())) }, t('common.create'))) : null),
    card(t('models.usage'), table(b.report, [['Day', (r) => r.day], ['Model', (r) => r.model], ['Calls', (r) => r.calls], ['Tokens', (r) => r.tokens], ['Cost $', (r) => Number(r.cost).toFixed(4)]]), h('details', {}, h('summary', {}, 'Insights'), json(b.insights))),
    card(`${t('models.decisions')} — chain: ${d.chain.join(' → ')}`, h('p.small.muted', {}, `${t('models.calibration')}: ${JSON.stringify(d.calibration)}`),
      table(d.recent.slice(0, 30), [['Time', (x) => when(x.created_at)], ['Purpose', (x) => x.purpose], ['Provider', (x) => x.provider], ['Confidence', (x) => (x.confidence ?? '') !== '' ? Number(x.confidence).toFixed(2) : ''], ['Answer', (x) => h('span.small', {}, String(x.answer ?? '').slice(0, 160))]])),
    card(t('models.tryDecision'), h('div.row', {}, state, h('button.primary', { onclick: safe(async () => tryOut.replaceChildren(json(await api('/api/decisions/try', { body: { state: state.value, questions: { sentiment: { type: 'choice', instructions: 'What is the sentiment of the text?', criteria: { positive: 'clearly positive', neutral: 'neither', negative: 'clearly negative' } }, urgent: { type: 'noul', instructions: 'Does this need an urgent response?' } } } })))) }, t('common.run'))), tryOut),
  ];
});

export const renderUsers = (view) => panel(view, t('users.title'), async (reload) => {
  const r = await api('/api/users');
  const u = field(t('auth.username'));
  const p = field(t('auth.password'), { type: 'password' });
  const role = h('select', {}, h('option', {}, 'user'), h('option', {}, 'admin'));
  const patch = (id, body) => safe(async () => (await api(`/api/users/${id}`, { method: 'PATCH', body }), reload()));
  return [
    card(null, table(r.users, [[t('auth.username'), (x) => x.username], [t('users.role'), (x) => x.role], [t('common.status'), (x) => badge(!x.disabled, 'active', t('users.disabled'))], ['Created', (x) => when(x.createdAt)],
      ['', (x) => h('span', {}, h('button', { onclick: patch(x.id, { role: x.role === 'admin' ? 'user' : 'admin' }) }, x.role === 'admin' ? '→ user' : '→ admin'), h('button', { onclick: patch(x.id, { disabled: !x.disabled }) }, x.disabled ? t('common.enable') : t('common.disable')),
        h('button.danger', { onclick: safe(async () => confirm(t('common.confirmDelete')) && (await api(`/api/users/${x.id}`, { method: 'DELETE' }), reload())) }, '×'))]])),
    card(t('users.add'), h('div.row', {}, u, p, role, h('button.primary', { onclick: safe(async () => (await api('/api/users', { body: { username: u.value, password: p.value, role: role.value } }), reload())) }, t('common.create')))),
  ];
});

let liveSource;
export async function renderDebug(view) {
  const live = h('div.events');
  liveSource?.close();
  liveSource = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  liveSource.addEventListener('event', (msg) => {
    const e = JSON.parse(msg.data);
    live.prepend(h('div', {}, `${new Date(e.ts).toLocaleTimeString()} `, h('code', {}, e.type), ` ${e.runId ?? ''} ${JSON.stringify(e.data).slice(0, 180)}`));
    while (live.childElementCount > 300) live.lastChild.remove();
  });
  view.append(card(t('runs.live'), live));
  await panel(view, t('debug.title'), async (reload) => {
    const d = await api('/api/debug').catch(() => null);
    const metrics = await api('/metrics').catch((e) => e.message);
    const audit = isAdmin() ? await api('/api/audit').catch(() => null) : null;
    const bp = d?.breakpoints ?? {};
    const setBp = (patch) => safe(async () => (await api('/api/debug/breakpoints', { body: patch }), reload()));
    const resume = (id, action) => safe(async () => (await api(`/api/debug/resume/${id}`, { body: { action } }), reload()));
    return [
      d ? card(t('debug.breakpoints'), h('div.row', {}, ...['llm', 'tool'].map((k) => h('button', { onclick: setBp({ [k]: !bp[k] }) }, `${k}: `, badge(bp[k])))), json(bp)) : null,
      d ? card(t('debug.paused'), table(d.paused, [['Step', (s) => s.id], ['Run', (s) => s.runId], ['Kind', (s) => s.kind], ['Payload', (s) => h('span.small', {}, JSON.stringify(s.payload).slice(0, 300))],
        ['', (s) => h('span', {}, h('button.primary', { onclick: resume(s.id, 'continue') }, t('debug.continue')), h('button.danger', { onclick: resume(s.id, 'abort') }, t('debug.abort')))]])) : null,
      audit ? card(`${t('debug.audit')} — integrity: ${audit.integrity.ok ? 'OK' : `broken at ${audit.integrity.brokenAt}`}`, table(audit.entries.slice(0, 50), [['Time', (a) => when(a.ts)], ['Actor', (a) => a.actor], ['Action', (a) => a.action], ['Target', (a) => a.target]])) : null,
      card(t('debug.metrics'), h('details', {}, h('summary', {}, '/metrics'), json(metrics))),
    ];
  });
}
export const stopDebug = () => liveSource?.close();

export const renderReflections = (view) => panel(view, t('reflections.title'), async () => {
  const r = await api('/api/reflections');
  return card(null, table(r.reflections, [['Time', (x) => when(x.created_at)], ['Run', (x) => x.run_id], [t('reflections.score'), (x) => (x.score ?? '') !== '' ? Number(x.score).toFixed(2) : ''], ['Verdict', (x) => x.verdict],
    [t('reflections.lessons'), (x) => h('ul.small', {}, (x.lessons || []).map((l) => h('li', {}, typeof l === 'string' ? l : JSON.stringify(l))))], ['Skill', (x) => x.skill]]));
});

export async function renderHelp(view) {
  const content = h('div.card');
  const open = safe(async (name) => {
    const r = await api(`/api/help?topic=${encodeURIComponent(name)}&locale=${state.locale}`);
    content.innerHTML = markdown(r.content);
  });
  const r = await api('/api/help');
  view.append(h('h2', {}, t('help.title')), h('div.grid2', {}, card(t('help.topics'), h('ul', {}, r.topics.map((x) => h('li', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), open(x.name)) }, x.title), h('div.small.muted', {}, x.summary))))), content));
  open('getting-started');
}

export const renderAccount = (view) => panel(view, t('account.title'), async (reload) => {
  const [me, tk] = await Promise.all([api('/api/auth/me'), api('/api/tokens')]);
  const name = field(t('common.name'));
  const scopes = h('div.row', {}, tk.scopes.map((s) => h('label.small', {}, h('input', { type: 'checkbox', value: s, checked: s === 'chat' }), ` ${s}`)));
  const shown = h('div');
  const pw = field(t('auth.password'), { type: 'password' });
  return [
    card(me.user.username, h('p', {}, `${t('users.role')}: ${me.user.role}`), h('div.row', {}, pw, h('button', { onclick: safe(async () => pw.value && (await api('/api/auth/me', { method: 'PATCH', body: { password: pw.value } }), toast(t('common.saved')))) }, t('common.save')))),
    card(t('account.tokens'), table(tk.tokens, [[t('common.name'), (x) => x.name], [t('account.scopes'), (x) => (x.scopes || []).join(', ')], ['Created', (x) => when(x.createdAt)], ['Expires', (x) => when(x.expiresAt)], [t('common.status'), (x) => badge(!x.revoked, 'active', 'revoked')],
      ['', (x) => h('button.danger', { onclick: safe(async () => (await api(`/api/tokens/${x.id}`, { method: 'DELETE' }), reload())) }, '×')]]),
      h('h4', {}, t('account.newToken')), h('div.row', {}, name, h('button.primary', { onclick: safe(async () => {
        const r = await api('/api/tokens', { body: { name: name.value, scopes: [...scopes.querySelectorAll('input:checked')].map((c) => c.value) } });
        shown.replaceChildren(h('p', {}, t('account.tokenShown')), json(r.token));
      }) }, t('common.create'))), scopes, shown),
  ];
});
