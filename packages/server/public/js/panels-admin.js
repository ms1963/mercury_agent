/** Panels: scheduler, integrations, models/router/budgets/Jev, users, observability/debug, reflections, help, account. */
import { api, badge, h, json, markdown, safe, setToken, state, t, table, toast, when } from './core.js';

const field = (placeholder, attrs = {}) => h('input', { placeholder, ...attrs });
const card = (title, ...children) => h('div.card', {}, title ? h('h3', {}, title) : null, ...children);
const isAdmin = () => state.user?.role === 'admin';

/** Re-render helper: build(container) is re-run by reload(). */
async function panel(view, title, build) {
  const body = h('div');
  // Filter out null/undefined/false: panels use `cond ? node : null` for conditional sections,
  // and replaceChildren() would otherwise stringify those into literal "null" text (the "nullnull" bug).
  const reload = safe(async () => body.replaceChildren(...[await build(reload)].flat().filter((c) => c != null && c !== false)));
  view.append(h('div.row', {}, h('h2.grow', {}, title), h('button', { onclick: reload }, t('common.refresh'))), body);
  await reload();
}

export const renderScheduler = (view) => panel(view, t('scheduler.title'), async (reload) => {
  const r = await api('/api/schedules');
  const whenIn = field(t('scheduler.when'), { className: 'grow' });
  const task = field(t('scheduler.task'), { className: 'grow' });
  const history = h('div');
  const editor = h('div');
  const act = (s, a) => safe(async () => (await api(`/api/schedules/${s.id}/${a}`, { body: {} }), reload()));
  const showHistory = async (s) =>
    history.replaceChildren(card(`${t('scheduler.history')}: ${s.name}`, json((await api(`/api/schedules/${s.id}/history`)).runs)));
  // Inline editor: change name, schedule (when) and task of an existing schedule.
  const showEditor = (s) => {
    const nameIn = field(t('common.name'), { value: s.name, className: 'grow' });
    const whenEdit = field(t('scheduler.when'), { value: s.nl || s.spec, className: 'grow' });
    // Multi-line editor for the task description, pre-filled with the current task, so longer
    // instructions are comfortable to read and edit (not a cramped single-line field).
    const taskEdit = h('textarea', { className: 'grow', rows: '5', placeholder: t('scheduler.task'), style: 'width:100%;resize:vertical;min-height:6em' }, s.task || '');
    taskEdit.value = s.task || '';
    const save = safe(async () => {
      await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { name: nameIn.value, when: whenEdit.value, task: taskEdit.value } });
      editor.replaceChildren();
      toast(t('common.saved'));
      await reload();
    });
    editor.replaceChildren(card(`${t('common.edit', 'Edit')}: ${s.name}`,
      h('div.row', {}, nameIn, whenEdit),
      h('div', { style: 'margin-top:.5em' }, h('label.small.muted', {}, t('scheduler.task')), taskEdit),
      h('div.row', { style: 'margin-top:.5em' }, h('button.primary', { onclick: save }, t('common.save', 'Save')),
        h('button', { onclick: safe(() => editor.replaceChildren()) }, t('common.cancel', 'Cancel')))));
  };
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
        h('button', { onclick: safe(() => showEditor(s)) }, t('common.edit', 'Edit')),
        h('button', { onclick: safe(() => showHistory(s)) }, t('scheduler.history')),
        h('button.danger', { onclick: safe(async () => confirm(t('common.confirmDelete')) && (await api(`/api/schedules/${s.id}`, { method: 'DELETE' }), reload())) }, '×'))],
    ])),
    card(t('common.create'), h('div.row', {}, whenIn, task, h('button.primary', { onclick: safe(async () => (await api('/api/schedules', { body: { when: whenIn.value, task: task.value, delivery: { platform: 'web' } } }), reload())) }, t('common.create')))),
    editor,
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

const laneBadge = (lane) => h(`span.badge.${lane === 'local' ? 'on' : lane === 'frontier' ? 'off' : ''}`, {}, lane || 'default');

export const renderModels = (view) => panel(view, t('models.title'), async (reload) => {
  const [m, b, d, tasks] = await Promise.all([api('/api/models'), api('/api/budgets'), api('/api/decisions'), api('/api/tasks').catch(() => null)]);
  const task = field(t('models.route'), { className: 'grow' });
  const routeOut = h('div');
  const budget = { user: field('user id or *', { value: '*' }), model: field('model or *', { value: '*' }), period: h('select', {}, h('option', {}, 'daily'), h('option', {}, 'monthly')), maxCost: field('max cost $', { type: 'number', step: '0.01' }), maxTokens: field('max tokens', { type: 'number' }) };
  const state = field('state (text)', { className: 'grow' });
  const tryOut = h('div');
  // Economics: per-task hard budgets + running cost-vs-value estimate.
  const econCard = () => {
    if (!tasks) return null;
    const cv = (t2) => t2.costVsValue || {};
    const econ = tasks.economics || {};
    const perTask = tasks.config || {};
    return card(t('models.economics', 'Economics — per-task budgets & cost-vs-value'),
      h('p.small.muted', {}, `${t('models.lanes', 'Lanes')}: ${econ.enabled ? 'enabled' : 'disabled'} · local ≤ difficulty ${econ.localLaneMaxDifficulty ?? ''} · quality margin ${econ.qualityMargin ?? 0} · per-task: ${perTask.enabled ? `on-exceed ${perTask.onExceed}` : 'off'}${perTask.maxCost ? ` · max $${perTask.maxCost}` : ''}`),
      table(tasks.tasks, [
        [t('models.task', 'Task/Run'), (x) => h('code', {}, x.taskId)],
        [t('common.status'), (x) => badge(x.state === 'active' || x.state === 'completed', x.state, x.state)],
        [t('models.cost', 'Cost $'), (x) => Number(cv(x).costSoFar ?? x.cost ?? 0).toFixed(4)],
        [t('models.projected', 'Projected $'), (x) => (cv(x).projectedCost ?? '') !== '' ? Number(cv(x).projectedCost).toFixed(4) : ''],
        [t('models.value', 'Value $'), (x) => cv(x).valueEstimate ?? ''],
        [t('models.valueRatio', 'Value/Cost'), (x) => (cv(x).valueRatio ?? '') !== '' ? String(cv(x).valueRatio) : ''],
        [t('models.budgetUsed', 'Budget used'), (x) => (cv(x).budgetUsedFraction ?? '') !== '' ? `${Math.round(cv(x).budgetUsedFraction * 100)}%` : ''],
        [t('models.overBudget', 'Over budget'), (x) => badge(!cv(x).overBudget, 'ok', 'over')],
      ]));
  };
  return [
    card(t('models.default'), h('p', {}, h('code', {}, m.defaultModel), ` · ${t('models.providers')}: ${m.providers.join(', ')}`),
      table(m.profiles, [['Model', (p) => h('code', {}, p.id)], ['Quality', (p) => p.quality], [t('models.lane', 'Lane'), (p) => laneBadge(p.lane)], ['Tags', (p) => p.tags.join(', ')], ['Context', (p) => p.contextWindow], ['$ in/out per 1M', (p) => `${p.costPer1MInput} / ${p.costPer1MOutput}`], [t('common.status'), (p) => badge(p.enabled)]])),
    econCard(),
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
  const cur = field(t('auth.currentPassword', 'Current password'), { type: 'password', autocomplete: 'current-password' });
  const pw = field(t('auth.newPassword', 'New password'), { type: 'password', autocomplete: 'new-password' });
  const changePw = safe(async () => {
    if (!pw.value) return;
    const r = await api('/api/auth/me', { method: 'PATCH', body: { password: pw.value, currentPassword: cur.value } });
    if (r && r.token) setToken(r.token);
    cur.value = ''; pw.value = '';
    toast(t('common.saved'));
  });
  return [
    card(me.user.username, h('p', {}, `${t('users.role')}: ${me.user.role}`), h('div.row', {}, cur, pw, h('button', { onclick: changePw }, t('common.save')))),
    card(t('account.tokens'), table(tk.tokens, [[t('common.name'), (x) => x.name], [t('account.scopes'), (x) => (x.scopes || []).join(', ')], ['Created', (x) => when(x.createdAt)], ['Expires', (x) => when(x.expiresAt)], [t('common.status'), (x) => badge(!x.revoked, 'active', 'revoked')],
      ['', (x) => h('button.danger', { onclick: safe(async () => (await api(`/api/tokens/${x.id}`, { method: 'DELETE' }), reload())) }, '×')]]),
      h('h4', {}, t('account.newToken')), h('div.row', {}, name, h('button.primary', { onclick: safe(async () => {
        const r = await api('/api/tokens', { body: { name: name.value, scopes: [...scopes.querySelectorAll('input:checked')].map((c) => c.value) } });
        shown.replaceChildren(h('p', {}, t('account.tokenShown')), json(r.token));
      }) }, t('common.create'))), scopes, shown),
  ];
});



/**
 * Verification: evidence-based completion. Shows recent verification results (passed checks,
 * per-check breakdown, confidence vs threshold) and open escalations flagged for human review.
 * Includes a form to run an ad-hoc verification (test/schema/critic/assertion checks) via POST
 * /api/verify. Reads need audit.read; resolving escalations needs config.manage (admin).
 */
export const renderVerification = (view) => panel(view, t('verification.title', 'Verification'), async (reload) => {
  const [v, esc] = await Promise.all([api('/api/verifications').catch(() => null), api('/api/escalations?status=open').catch(() => ({ escalations: [] }))]);
  const confBadge = (x) => h(`span.badge.${x.passed ? 'on' : 'off'}`, {}, `${Number(x.confidence).toFixed(2)} / ${x.threshold}`);

  const resultsCard = v ? card(t('verification.results', 'Verification results'),
    h('p.small.muted', {}, `${t('verification.intro', 'A task is done only on evidence (passed checks), not because the model claimed done.')} ${v.enabled ? '' : '(disabled)'} · threshold ${v.config?.confidenceThreshold ?? ''} · escalate ${v.config?.escalate ? 'on' : 'off'}`),
    table(v.verifications, [
      [t('verification.task', 'Task'), (x) => h('span.small', {}, x.taskId || x.runId || x.id)],
      [t('verification.goal', 'Goal'), (x) => h('span.small', {}, x.goal || '')],
      [t('common.status'), (x) => badge(x.passed, t('verification.done', 'done'), t('verification.notDone', 'not done'))],
      [t('verification.confidence', 'Confidence'), confBadge],
      [t('verification.checks', 'Checks'), (x) => h('details', {}, h('summary', {}, `${(x.checks || []).filter((c) => c.passed).length}/${(x.checks || []).length}`),
        h('ul.small', {}, (x.checks || []).map((c) => h('li', {}, `${c.passed ? '✓' : '✗'} ${c.type}${c.required ? '*' : ''} (${Number(c.score).toFixed(2)}) — ${c.detail}`))))],
      [t('verification.escalated', 'Escalated'), (x) => x.escalated ? h('span.badge.off', {}, '⚠') : ''],
      ['Time', (x) => when(x.createdAt)],
    ])) : null;

  const escCard = card(t('verification.escalations', 'Escalations (human review)'),
    h('p.small.muted', {}, t('verification.escIntro', 'Low-confidence results flagged for a human instead of being marked done.')),
    table(esc.escalations, [
      [t('verification.task', 'Task'), (x) => h('span.small', {}, x.taskId || x.runId || x.id)],
      [t('verification.reason', 'Reason'), (x) => h('span.small', {}, x.reason)],
      [t('verification.confidence', 'Confidence'), (x) => (x.confidence ?? '') !== '' ? Number(x.confidence).toFixed(2) : ''],
      ['Time', (x) => when(x.createdAt)],
      ['', (x) => isAdmin() ? h('button', { onclick: safe(async () => (await api(`/api/escalations/${x.id}/resolve`, { body: {} }), toast(t('common.saved')), reload())) }, t('verification.resolve', 'Resolve')) : null],
    ]));

  // ad-hoc verification runner
  const goal = field(t('verification.goal', 'goal'), { className: 'grow' });
  const output = field(t('verification.output', 'output text (for critic)'), { className: 'grow' });
  const checksIn = field(t('verification.checksJson', 'checks JSON e.g. [{"type":"assertion","checker":"file_exists","params":{"path":"/etc/hostname"},"required":true}]'), { className: 'grow' });
  const runOut = h('div');
  const runCard = card(t('verification.run', 'Run a verification'),
    h('div.row', {}, goal, output), h('div.row', {}, checksIn, h('button.primary', { onclick: safe(async () => {
      let checks = [];
      try { checks = checksIn.value ? JSON.parse(checksIn.value) : []; } catch { return toast(t('verification.badJson', 'checks must be valid JSON'), true); }
      const r = await api('/api/verify', { body: { goal: goal.value || undefined, output: output.value || undefined, checks } });
      runOut.replaceChildren(h('p', {}, t('verification.result', 'Result') + ': ', confBadge(r), ` — ${r.summary}`), json(r));
      await reload();
    }) }, t('common.run'))), runOut);

  return [resultsCard, escCard, runCard];
});

/**
 * Reliability engineering: per-agent SLOs (success rate, intervention/escalation rate, cost per
 * task), recorded runs that can be replayed as regression tests, and chaos fault-injection status.
 */
export const renderReliability = (view) => panel(view, t('reliability.title', 'Reliability'), async (reload) => {
  const [slo, rec, chaos] = await Promise.all([
    api('/api/slo').catch(() => null),
    api('/api/recordings').catch(() => ({ recordings: [] })),
    api('/api/chaos').catch(() => null),
  ]);
  const replayOut = h('div');

  const sloCard = slo ? card(t('reliability.slo', 'SLOs per agent'),
    h('p.small.muted', {}, `${t('reliability.sloIntro', 'Service-level objectives computed from run history.')} · window ${slo.windowDays}d · targets: success ≥ ${slo.targets.targetSuccessRate}, intervention ≤ ${slo.targets.maxInterventionRate}, cost/task ≤ $${slo.targets.maxCostPerTask}`),
    table(slo.agents, [
      [t('reliability.agent', 'Agent'), (x) => h('code', {}, x.agent)],
      [t('reliability.runs', 'Runs'), (x) => x.runs],
      [t('reliability.successRate', 'Success rate'), (x) => badge(x.meetsSuccess, `${Math.round(x.successRate * 100)}%`, `${Math.round(x.successRate * 100)}%`)],
      [t('reliability.interventionRate', 'Intervention'), (x) => badge(x.meetsIntervention, `${Math.round(x.interventionRate * 100)}%`, `${Math.round(x.interventionRate * 100)}%`)],
      [t('reliability.costPerTask', 'Cost/task $'), (x) => badge(x.meetsCost, Number(x.costPerTask).toFixed(4), Number(x.costPerTask).toFixed(4))],
      [t('reliability.escalations', 'Escalations'), (x) => x.escalations],
    ])) : null;

  const chaosCard = chaos ? card(t('reliability.chaos', 'Chaos testing'),
    h('p.small.muted', {}, t('reliability.chaosIntro', 'Deliberately injects tool failures/timeouts to verify the agent recovers (retries, fallbacks). OFF by default.')),
    h('p', {}, t('common.status') + ': ', badge(!chaos.enabled, t('reliability.chaosOff', 'off (safe)'), t('reliability.chaosOn', 'ON — injecting failures')),
      chaos.enabled ? h('span.small', {}, ` · fail ${Math.round(chaos.failureProbability * 100)}% · timeout ${Math.round(chaos.timeoutProbability * 100)}% · injected ${chaos.injections}`) : null)) : null;

  const recCard = card(t('reliability.recordings', 'Recorded runs (replay as regression)'),
    h('p.small.muted', {}, t('reliability.recIntro', 'Replay a recorded run and diff the outcome — a regression test for model/prompt/skill changes.')),
    table(rec.recordings, [
      [t('common.name'), (x) => h('span.small', {}, x.name || x.id)],
      [t('verification.input', 'Input'), (x) => h('span.small', {}, (x.input || '').slice(0, 80))],
      [t('reliability.toolCalls', 'Tools'), (x) => (x.toolCalls || []).length],
      ['Time', (x) => when(x.createdAt)],
      ['', (x) => h('button', { onclick: safe(async () => {
        replayOut.replaceChildren(h('p.muted', {}, t('reliability.replaying', 'Replaying…')));
        const r = await api(`/api/recordings/${x.id}/replay`, { body: {} });
        replayOut.replaceChildren(h('p', {}, t('reliability.diff', 'Diff') + ': ', badge(r.match, t('reliability.match', 'match'), t('reliability.regression', 'regression')), ` — ${r.summary}`), json(r));
      }) }, t('reliability.replay', 'Replay'))],
    ]), replayOut);

  return [sloCard, chaosCard, recCard];
});

/**
 * Learning from runs: experience hints distilled from past successful runs, auto-tuned routing
 * stats fed back to the router per (difficulty bucket, model), and failure playbooks. Read-only
 * — the learning service tunes itself from run history. OFF by default (config.learning.enabled).
 */
export const renderLearning = (view) => panel(view, t('learning.title', 'Learning'), async () => {
  const data = await api('/api/learning').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('learning.unavailable', 'learning subsystem unavailable')));

  const statusCard = card(t('learning.status', 'Status'),
    h('p.small.muted', {}, t('learning.intro', 'Mercury learns from completed runs: it injects hints from similar past successes, tunes model routing per difficulty bucket from observed success rates, and records failure playbooks. Everything is off by default and falls back gracefully when there is not enough data.')),
    h('p', {}, t('common.status') + ': ', badge(data.enabled, t('learning.on', 'learning ON'), t('learning.off', 'off (safe)')),
      h('span.small', {}, ` · hints ${data.config.hints ? 'on' : 'off'} · routing ${data.config.routing ? 'on' : 'off'} · playbooks ${data.config.playbooks ? 'on' : 'off'}`)));

  const statsCard = card(t('learning.routeStats', 'Auto-tuned routing (per difficulty bucket / model)'),
    h('p.small.muted', {}, t('learning.routeIntro', 'Observed success rates per difficulty bucket and model, fed back to the router. The router prefers a model only once there are enough samples; otherwise it falls back to economics.')),
    table(data.routeStats, [
      [t('learning.bucket', 'Bucket'), (x) => h('code', {}, x.bucket)],
      [t('learning.model', 'Model'), (x) => h('code', {}, x.model)],
      [t('learning.lane', 'Lane'), (x) => h('span.small', {}, x.lane || '—')],
      [t('reliability.runs', 'Runs'), (x) => x.runs],
      [t('reliability.successRate', 'Success rate'), (x) => badge(x.successRate >= 0.5, `${Math.round(x.successRate * 100)}%`, `${Math.round(x.successRate * 100)}%`)],
      [t('learning.avgCost', 'Avg cost $'), (x) => Number(x.avgCost).toFixed(5)],
    ]));

  const playbookCard = card(t('learning.playbooks', 'Failure playbooks'),
    h('p.small.muted', {}, t('learning.playbookIntro', 'Recurring error signatures and the remediation that later worked, so the agent can avoid repeating known failures.')),
    table(data.playbooks, [
      [t('learning.signature', 'Signature'), (x) => h('code.small', {}, x.signature)],
      [t('learning.error', 'Error'), (x) => h('span.small', {}, (x.errorSample || '').slice(0, 70))],
      [t('learning.remediation', 'Remediation'), (x) => h('span.small', {}, (x.remediation || '—').slice(0, 90))],
      [t('learning.occurrences', 'Seen'), (x) => x.occurrences],
      [t('learning.resolved', 'Resolved'), (x) => x.successes],
    ]));

  return [statusCard, statsCard, playbookCard];
});

/**
 * Self-distilling skills: reusable parameterized skills the agent distilled from its own winning
 * run traces. Shows each skill's trigger, step sequence, governance status and running stats, with
 * approve/retire actions (admins). A pending skill must be approved before the planner reuses it.
 */
export const renderDistill = (view) => panel(view, t('distill.title', 'Distilled Skills'), async (reload) => {
  const data = await api('/api/distilled-skills').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('distill.unavailable', 'distilled-skills subsystem unavailable')));

  const statusCard = card(t('distill.status', 'Status'),
    h('p.small.muted', {}, t('distill.intro', 'Mercury distils reusable, parameterized skills from its own successful (or 👍-rated) runs: the proven tool sequence with concrete values generalized into parameters. New skills land in a review queue; once approved, the planner reuses a matching skill to run the proven path. Off by default.')),
    h('p', {}, t('common.status') + ': ', badge(data.enabled, t('distill.on', 'distilling ON'), t('distill.off', 'off (safe)')),
      h('span.small', {}, ` · ${t('distill.autoApprove', 'auto-approve')} ${data.config.autoApprove ? 'on' : 'off'} · ${t('distill.matchMin', 'match ≥')} ${data.config.matchMinSimilarity} · ${t('distill.retireBelow', 'retire < ')} ${Math.round(data.config.retireBelowSuccessRate * 100)}% ${t('distill.overN', 'over')} ${data.config.minRunsBeforeRetire} ${t('distill.uses', 'uses')}`)));

  const statusBadge = (s) => h(`span.badge.${s === 'approved' ? 'on' : s === 'retired' ? 'off' : ''}`, {}, s);
  const steps = (x) => h('span.small', {}, (x.steps || []).map((st) => st.tool).join(' → ') || '—');
  const actions = (x) => !isAdmin() ? null : h('div.row', {},
    x.status !== 'approved' ? h('button.primary', { onclick: safe(async () => (await api(`/api/distilled-skills/${x.id}/approve`, { body: {} }), toast(t('distill.approved', 'Skill approved')), reload())) }, t('distill.approve', 'Approve')) : null,
    x.status !== 'retired' ? h('button', { onclick: safe(async () => (await api(`/api/distilled-skills/${x.id}/retire`, { body: {} }), toast(t('distill.retired', 'Skill retired')), reload())) }, t('distill.retire', 'Retire')) : null);

  const skillsCard = card(t('distill.skills', 'Distilled skills'),
    data.skills.length ? table(data.skills, [
      [t('distill.name', 'Name'), (x) => h('code', {}, x.name)],
      [t('distill.trigger', 'Trigger'), (x) => h('span.small', {}, (x.trigger || '').slice(0, 60))],
      [t('distill.steps', 'Steps'), steps],
      [t('distill.params', 'Params'), (x) => h('span.small', {}, (x.params || []).map((p) => p.name).join(', ') || '—')],
      [t('distill.version', 'Ver'), (x) => x.version],
      [t('common.status'), (x) => statusBadge(x.status)],
      [t('distill.usesCol', 'Uses'), (x) => x.stats.uses],
      [t('reliability.successRate', 'Success rate'), (x) => badge(x.stats.successRate >= 0.5, `${Math.round(x.stats.successRate * 100)}%`, `${Math.round(x.stats.successRate * 100)}%`)],
      [t('distill.avgCost', 'Avg cost $'), (x) => Number(x.stats.avgCost).toFixed(5)],
      ['', actions],
    ]) : h('p.muted', {}, t('distill.empty', 'No skills distilled yet. Run tasks with distilling enabled, or 👍 a good run.')));

  return [statusCard, skillsCard];
});

/**
 * Proactive (but not annoying): pending/reacted events, the deferred digest queue and the
 * notification rules that map events to actions and interrupt-vs-defer routing.
 */
export const renderProactive = (view) => panel(view, t('proactive.title', 'Proactive'), async (reload) => {
  const data = await api('/api/proactive').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, 'proactive subsystem unavailable'));
  const prioBadge = (x) => h(`span.badge.${x.decision === 'interrupt' ? 'on' : ''}`, {}, `${Number(x.priority).toFixed(2)} ${x.decision}`);

  const emit = { source: field('source e.g. ci'), kind: field('kind e.g. build.failed'), title: field('title', { className: 'grow' }), body: field('body', { className: 'grow' }) };

  return [
    card(t('proactive.rules', 'Notification rules'),
      h('p.small.muted', {}, `${t('proactive.intro', 'Events map to actions; high-priority events interrupt immediately, low-priority ones are batched into a digest.')} ${data.enabled ? '' : '(disabled)'} · interrupt ≥ ${data.config?.interruptThreshold ?? ''} · digest ${data.config?.digestCron ?? ''}`),
      table(data.rules, [
        ['Id', (r) => h('code', {}, r.id)],
        [t('proactive.source', 'Source'), (r) => h('code', {}, r.source)],
        [t('proactive.kind', 'Kind'), (r) => h('code', {}, r.kind)],
        [t('proactive.route', 'Route'), (r) => r.route || t('proactive.auto', 'auto')],
        [t('proactive.priority', 'Priority'), (r) => r.priority],
        [t('common.description'), (r) => h('span.small', {}, r.description)],
      ])),
    card(t('proactive.pending', 'Recent events'),
      table(data.events, [
        [t('proactive.source', 'Source'), (x) => h('code', {}, `${x.source}/${x.kind}`)],
        [t('proactive.eventTitle', 'Title'), (x) => h('span.small', {}, x.title || '')],
        [t('proactive.priority', 'Priority'), prioBadge],
        [t('common.status'), (x) => badge(x.status !== 'pending', x.status, x.status)],
        ['Rule', (x) => h('span.small', {}, x.rule || '')],
        ['Time', (x) => when(x.createdAt)],
      ])),
    card(t('proactive.digest', 'Digest queue (deferred)'),
      h('p.small.muted', {}, t('proactive.digestIntro', 'Low-priority updates waiting to be bundled into the next digest instead of interrupting.')),
      table(data.digest, [
        [t('proactive.source', 'Source'), (x) => h('code', {}, `${x.source}/${x.kind}`)],
        [t('proactive.eventTitle', 'Title'), (x) => h('span.small', {}, x.title || '')],
        [t('proactive.priority', 'Priority'), (x) => Number(x.priority).toFixed(2)],
        ['Time', (x) => when(x.createdAt)],
      ]),
      isAdmin() ? h('div.row', {}, h('button.primary', { onclick: safe(async () => (await api('/api/proactive/digest/flush', { body: {} }), toast(t('proactive.flushed', 'Digest flushed')), reload())) }, t('proactive.flush', 'Flush digest now')),
        h('button', { onclick: safe(async () => (await api('/api/proactive/poll', { body: {} }), toast(t('common.saved')), reload())) }, t('proactive.poll', 'Poll sources'))) : null),
    isAdmin() ? card(t('proactive.testEvent', 'Inject a test event'),
      h('div.row', {}, ...Object.values(emit), h('button.primary', { onclick: safe(async () => {
        if (!emit.source.value || !emit.kind.value) return toast('source and kind required', true);
        await api('/api/proactive/events', { body: { source: emit.source.value, kind: emit.kind.value, title: emit.title.value, body: emit.body.value } });
        toast(t('common.saved'));
        await reload();
      }) }, t('common.create')))) : null,
  ];
});

/**
 * Governance & security: time-limited capability grants, policy-as-code, and the replayable
 * audit trail ("why did you do that?"). Reads are available to audit.read holders; issuing and
 * revoking grants require config.manage (admin).
 */
export const renderGovernance = (view) => panel(view, t('governance.title', 'Governance & security'), async (reload) => {
  const [g, pol] = await Promise.all([api('/api/grants').catch(() => null), api('/api/policies').catch(() => null)]);
  const decisionBadge = (dec) => h(`span.badge.${dec === 'allow' ? 'on' : 'off'}`, {}, dec);

  // ---- capability grants ----
  const gi = { capability: field(t('governance.capability', 'capability (e.g. payment.charge)')), taskId: field(t('governance.taskId', 'task/run id')), scope: field(t('governance.scope', 'scope (optional)')), ttlMs: field('ttl ms', { type: 'number' }), maxUses: field('max uses', { type: 'number' }) };
  const grantsCard = g ? card(t('governance.grants', 'Capability grants'),
    h('p.small.muted', {}, `${t('governance.grantsIntro', 'Least-privilege, time-limited grants — no standing keys.')} ${g.enabled ? '' : '(disabled)'} · default TTL ${g.config?.defaultTtlMs ?? ''}ms · max TTL ${g.config?.maxTtlMs ?? ''}ms`),
    table(g.grants, [
      [t('governance.capability', 'Capability'), (x) => h('code', {}, x.capability)],
      [t('governance.taskId', 'Task'), (x) => h('span.small', {}, x.taskId)],
      [t('governance.scope', 'Scope'), (x) => x.scope || '*'],
      ['Uses', (x) => `${x.uses}${x.maxUses != null ? '/' + x.maxUses : ''}`],
      ['Expires', (x) => when(new Date(x.expiresAt).toISOString())],
      [t('common.status'), (x) => badge(x.active, 'active', x.revoked ? 'revoked' : 'expired')],
      ['', (x) => isAdmin() && x.active ? h('button.danger', { onclick: safe(async () => (await api(`/api/grants/${x.id}`, { method: 'DELETE' }), toast(t('common.saved')), reload())) }, '×') : null],
    ]),
    isAdmin() ? h('div.row', {}, ...Object.values(gi), h('button.primary', { onclick: safe(async () => {
      if (!gi.capability.value || !gi.taskId.value) return toast(t('governance.needCapTask', 'capability and task id are required'), true);
      await api('/api/grants', { body: { capability: gi.capability.value, taskId: gi.taskId.value, scope: gi.scope.value || undefined, ttlMs: gi.ttlMs.value ? Number(gi.ttlMs.value) : undefined, maxUses: gi.maxUses.value ? Number(gi.maxUses.value) : undefined } });
      toast(t('governance.granted', 'Grant issued'));
      await reload();
    }) }, t('governance.issue', 'Issue grant'))) : null) : null;

  // ---- policy-as-code ----
  const pt = { tool: field(t('governance.tool', 'tool name'), { className: 'grow' }), args: field(t('governance.args', 'args JSON e.g. {"amount":250}'), { className: 'grow' }), tainted: h('label.small', {}, h('input', { type: 'checkbox' }), ' tainted') };
  const ptOut = h('div');
  const policiesCard = pol ? card(t('governance.policies', 'Policy-as-code'),
    h('p.small.muted', {}, t('governance.policiesIntro', 'Declarative rules evaluated before sensitive actions. Strictest effect wins (deny > approve > allow).') + ` ${pol.enabled ? '' : '(disabled)'}`),
    table(pol.rules, [
      ['Id', (r) => h('code', {}, r.id)],
      [t('common.description'), (r) => h('span.small', {}, r.description)],
      [t('governance.tool', 'Tool'), (r) => h('code', {}, r.tool)],
      [t('governance.effect', 'Effect'), (r) => decisionBadge(r.effect)],
      [t('governance.whenTainted', 'Tainted only'), (r) => r.whenTainted ? '✓' : ''],
    ]),
    h('h4', {}, t('governance.testPolicy', 'Test a policy decision')),
    h('div.row', {}, pt.tool, pt.args, pt.tainted, h('button.primary', { onclick: safe(async () => {
      let args = {};
      try { args = pt.args.value ? JSON.parse(pt.args.value) : {}; } catch { return toast(t('governance.badJson', 'args must be valid JSON'), true); }
      const r = await api('/api/policies/test', { body: { tool: pt.tool.value, args, tainted: pt.tainted.querySelector('input').checked } });
      ptOut.replaceChildren(h('p', {}, t('governance.decision', 'Decision') + ': ', decisionBadge(r.decision), ` — ${r.reason}`), r.rule ? json(r.rule) : null);
    }) }, t('common.run'))), ptOut) : null;

  // ---- replayable audit trail ----
  const runId = field(t('governance.runId', 'run id'), { className: 'grow' });
  const traceOut = h('div');
  const catBadge = (c) => h('span.badge', {}, c);
  const showTrace = safe(async () => {
    const tr = await api(`/api/runs/${encodeURIComponent(runId.value.trim())}/trace`);
    traceOut.replaceChildren(
      h('p.small.muted', {}, tr.summary),
      h('p.small', {}, `${tr.llmCalls} LLM · ${tr.toolCalls} tools · ${tr.decisions} decisions · $${tr.totalCost} · ${tr.totalTokens} tokens${tr.tainted ? ' · ⚠ tainted' : ''}${tr.durationMs != null ? ` · ${tr.durationMs}ms` : ''}`),
      table(tr.steps, [
        ['#', (s) => s.seq],
        ['Time', (s) => new Date(s.ts).toLocaleTimeString()],
        [t('governance.category', 'Category'), (s) => catBadge(s.category)],
        [t('governance.step', 'Step'), (s) => h('span.small', {}, s.summary)],
      ]));
  });
  const traceCard = card(t('governance.trace', 'Replayable audit trail'),
    h('p.small.muted', {}, t('governance.traceIntro', 'Replay an ordered, human-readable trace of a run to answer "why did you do that?".')),
    h('div.row', {}, runId, h('button.primary', { onclick: showTrace }, t('governance.replay', 'Replay'))), traceOut);

  return [grantsCard, policiesCard, traceCard];
});

/**
 * Deterministic run replay & time-travel debugging: list traced runs, open a run's timeline,
 * scrub across steps to inspect the reconstructed state, edit the input and re-run (fork) from a
 * chosen step — streaming the recomputed downstream as a new linked run.
 */
export const renderReplay = (view) => panel(view, t('replay.title', 'Run Replay'), async (reload) => {
  const sel = state.replaySel || {};
  const data = await api('/api/traces').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('replay.unavailable', 'run replay is disabled')));

  const intro = card(t('replay.status', 'Time-travel debugging'),
    h('p.small.muted', {}, t('replay.intro', 'Every run is traced. Open a run to scrub its timeline, inspect the reconstructed state at each step, edit an input, and re-run deterministically from any step — forking a new linked run that reuses the upstream prefix and recomputes everything downstream.')));

  const runsCard = card(t('replay.runs', 'Traced runs'),
    data.traces.length ? table(data.traces, [
      [t('replay.runId', 'Run'), (x) => h('code.small', {}, x.runId.slice(0, 18))],
      [t('replay.input', 'Input'), (x) => h('span.small', {}, (x.input || '').slice(0, 50))],
      [t('replay.steps', 'Steps'), (x) => x.steps],
      [t('replay.parent', 'Forked from'), (x) => x.parentRunId ? h('code.small', {}, `${x.parentRunId.slice(0, 10)}@${x.fromStep}`) : '—'],
      ['', (x) => h('button', { onclick: safe(async () => { state.replaySel = { runId: x.runId, step: x.steps }; await reload(); }) }, t('replay.open', 'Open'))],
    ]) : h('p.muted', {}, t('replay.empty', 'No traced runs yet. Run a task first.')));

  if (!sel.runId) return [intro, runsCard];

  const trace = await api(`/api/runs/${sel.runId}/timetravel`).catch(() => null);
  if (!trace) return [intro, runsCard, card(null, h('p.muted', {}, t('replay.notrace', 'No trace for this run.')))];
  const total = trace.steps.length;
  const step = Math.max(0, Math.min(sel.step ?? total, total));
  const stateAt = await api(`/api/runs/${sel.runId}/state?step=${step}`).catch(() => null);

  const timeline = card(`${t('replay.timeline', 'Timeline')} — ${sel.runId.slice(0, 18)} (${total} ${t('replay.steps', 'steps')})`,
    h('input', { type: 'range', min: 0, max: String(total), value: String(step), style: 'width:100%',
      oninput: safe(async (e) => { state.replaySel = { ...sel, step: Number(e.target.value) }; await reload(); }) }),
    h('p.small.muted', {}, `${t('replay.atStep', 'Step')} ${step} / ${total}`),
    h('ol.small', {}, trace.steps.map((s) => h(`li${s.seq === step ? '.active' : ''}`, {},
      h('a', { href: '#', onclick: safe(async (e) => { e.preventDefault(); state.replaySel = { ...sel, step: s.seq }; await reload(); }) },
        `${s.seq}. [${s.category}] ${s.summary}`)))));

  const stateCard = card(t('replay.state', 'Reconstructed state at step'),
    stateAt ? h('div', {},
      h('p.small', {}, `${t('replay.llm', 'LLM calls')}: ${stateAt.llmCalls} · ${t('replay.tools', 'tool calls')}: ${stateAt.toolCalls} · ${t('replay.cost', 'cost $')}: ${Number(stateAt.cost).toFixed(5)} · ${t('replay.tokens', 'tokens')}: ${stateAt.tokens}${stateAt.tainted ? ' · ⚠ tainted' : ''}`),
      h('pre.small', { style: 'max-height:220px;overflow:auto' }, (stateAt.messages || []).map((msgp) => `${msgp.role}: ${(msgp.content || '').slice(0, 200)}`).join('\n') || '—'))
      : h('p.muted', {}, '—'));

  const forkCard = card(t('replay.fork', 'Re-run from here (fork)'),
    h('p.small.muted', {}, t('replay.forkHelp', 'Reuse everything up to the selected step, edit the instruction, and recompute downstream as a new linked run.')),
    (() => { const inp = field(t('replay.editInput', 'Edited input (blank = reuse original)'), { id: 'replay-edit', value: '' });
      return h('div.row', {}, inp,
        h('button.primary', { onclick: safe(async () => {
          const edits = inp.value.trim() ? { input: inp.value.trim() } : {};
          const res = await api(`/api/runs/${sel.runId}/replay`, { body: { fromStep: step, edits } });
          toast(`${t('replay.forked', 'Forked run')} ${res.run.runId.slice(0, 12)} (${res.run.status})`);
          state.replaySel = { runId: res.run.runId, step: undefined };
          await reload();
        }) }, t('replay.rerun', 'Re-run from step'))); })());

  return [intro, runsCard, timeline, stateCard, forkCard];
});



/**
 * Evaluation-driven self-improvement: closed eval suites promoted from real/👍-rated runs, a scored
 * regression gate (pass-rate, cost-per-task, intervention-rate, output-similarity), and a GOVERNED
 * auto-tuner that proposes config changes, tests each against the suite and keeps only the ones that
 * improve the score without breaking governance or the per-task budget. Accepted tunes are versioned
 * and reversible. Auto-apply is off by default.
 */
export const renderEvals = (view) => panel(view, t('evals.title', 'Evaluations & Auto-tune'), async (reload) => {
  const data = await api('/api/evals').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('evals.unavailable', 'evals subsystem unavailable')));
  const sel = state.evalSel || {};
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;

  const at = data.config.autotune || {};
  const statusCard = card(t('evals.status', 'Status'),
    h('p.small.muted', {}, t('evals.intro', 'Promote real (or 👍-rated) runs into labeled eval cases, replay a suite for a single blended score (pass-rate, cost-per-task, intervention-rate, output-similarity), and let the governed auto-tuner propose, test and keep only changes that improve the score — never breaking governance or the per-task budget. Accepted tunes are versioned and reversible.')),
    h('p', {}, t('common.status') + ': ', badge(data.enabled, t('evals.on', 'evals ON'), t('evals.off', 'off')),
      h('span.small', {}, ` · ${t('evals.autotune', 'auto-tune')} ${at.enabled ? t('evals.autotuneOn', 'ON') : t('evals.autotuneOff', 'off (safe)')} · ${t('evals.autoApply', 'auto-apply')} ${at.autoApply ? 'on' : 'off'} · ${t('evals.minImprovement', 'min improvement')} ${pct(at.minImprovement)} · ${t('evals.costCeiling', 'cost ceiling $')}${data.config.costCeiling}`)));

  // ---- create suite (admin) ----
  const si = { name: field(t('evals.suiteName', 'suite name'), { className: 'grow' }), agent: field(t('evals.agent', 'agent (default)')), description: field(t('common.description'), { className: 'grow' }) };
  const createCard = isAdmin() ? card(t('evals.newSuite', 'New suite'),
    h('div.row', {}, ...Object.values(si), h('button.primary', { onclick: safe(async () => {
      if (!si.name.value) return toast(t('evals.needName', 'name is required'), true);
      await api('/api/evals/suites', { body: { name: si.name.value, agent: si.agent.value || 'default', description: si.description.value } });
      toast(t('common.saved')); si.name.value = ''; await reload();
    }) }, t('common.create')))) : null;

  const suitesCard = card(t('evals.suites', 'Suites'),
    data.suites.length ? table(data.suites, [
      [t('evals.suiteName', 'Suite'), (x) => h('code', {}, x.name)],
      [t('evals.agent', 'Agent'), (x) => h('span.small', {}, x.agent)],
      [t('common.description'), (x) => h('span.small', {}, (x.description || '').slice(0, 60))],
      ['', (x) => h('button', { onclick: safe(async () => { state.evalSel = { suiteId: x.id }; await reload(); }) }, t('evals.open', 'Open'))],
    ]) : h('p.muted', {}, t('evals.noSuites', 'No suites yet. Create one, then promote runs into it.')));

  if (!sel.suiteId) return [statusCard, createCard, suitesCard];

  // ---- selected suite detail ----
  const detail = await api(`/api/evals/suites/${sel.suiteId}`).catch(() => null);
  if (!detail) return [statusCard, createCard, suitesCard, card(null, h('p.muted', {}, t('evals.suiteGone', 'Suite not found.')))];

  const casesCard = card(`${t('evals.cases', 'Cases')} — ${detail.suite.name}`,
    detail.cases.length ? table(detail.cases, [
      [t('evals.caseName', 'Case'), (x) => h('code.small', {}, x.name)],
      [t('evals.input', 'Input'), (x) => h('span.small', {}, (x.input || '').slice(0, 50))],
      [t('evals.expectTools', 'Expect tools'), (x) => h('span.small', {}, (x.expected?.tools || []).join(', ') || '—')],
      [t('evals.expectContains', 'Contains'), (x) => h('span.small', {}, (x.expected?.contains || []).join(', ') || '—')],
      [t('evals.maxCost', 'Max $'), (x) => x.expected?.maxCost ?? '—'],
      [t('evals.source', 'From run'), (x) => x.sourceRunId ? h('code.small', {}, x.sourceRunId.slice(0, 10)) : '—'],
      ['', (x) => isAdmin() ? h('button.danger', { onclick: safe(async () => (await api(`/api/evals/cases/${x.id}`, { method: 'DELETE' }), toast(t('common.saved')), reload())) }, '×') : null],
    ]) : h('p.muted', {}, t('evals.noCases', 'No cases yet.')));

  const ci = { name: field(t('evals.caseName', 'case name')), input: field(t('evals.input', 'input'), { className: 'grow' }), tools: field(t('evals.expectTools', 'expect tools (comma)')), contains: field(t('evals.expectContains', 'contains (comma)')), output: field(t('evals.refOutput', 'reference output (optional)'), { className: 'grow' }), maxCost: field(t('evals.maxCost', 'max $'), { type: 'number', step: '0.001' }) };
  const addCaseCard = isAdmin() ? card(t('evals.addCase', 'Add a case'),
    h('div.row', {}, ...Object.values(ci), h('button.primary', { onclick: safe(async () => {
      if (!ci.name.value || !ci.input.value) return toast(t('evals.needCase', 'name and input are required'), true);
      const expected = {};
      if (ci.tools.value.trim()) expected.tools = ci.tools.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (ci.contains.value.trim()) expected.contains = ci.contains.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (ci.output.value.trim()) expected.output = ci.output.value.trim();
      if (ci.maxCost.value) expected.maxCost = Number(ci.maxCost.value);
      await api('/api/evals/cases', { body: { suiteId: sel.suiteId, name: ci.name.value, input: ci.input.value, expected } });
      toast(t('common.saved')); ci.name.value = ci.input.value = ''; await reload();
    }) }, t('common.create')))) : null;

  const pi = { runId: field(t('evals.runId', 'run id to promote'), { className: 'grow' }), name: field(t('evals.caseName', 'case name (optional)')) };
  const promoteCard = isAdmin() ? card(t('evals.promote', 'Promote a run → eval case'),
    h('p.small.muted', {}, t('evals.promoteHelp', 'Turn a real run into a labeled, reproducible case: its input plus the tools it fired and its output become the expected outcome.')),
    h('div.row', {}, ...Object.values(pi), h('button.primary', { onclick: safe(async () => {
      if (!pi.runId.value) return toast(t('evals.needRun', 'run id is required'), true);
      await api('/api/evals/promote', { body: { runId: pi.runId.value.trim(), suiteId: sel.suiteId, name: pi.name.value || undefined } });
      toast(t('evals.promoted', 'Run promoted to a case')); pi.runId.value = ''; await reload();
    }) }, t('evals.promoteBtn', 'Promote')))) : null;

  const trendCard = card(t('evals.trend', 'Scorecard trend'),
    detail.trend.length ? table(detail.trend, [
      [t('evals.label', 'Label'), (x) => h('span.small', {}, x.label || '—')],
      [t('evals.score', 'Score'), (x) => badge((x.score ?? 0) >= 0.5, pct(x.score), pct(x.score))],
      [t('evals.passRate', 'Pass'), (x) => pct(x.passRate)],
      [t('evals.costPerTask', '$/task'), (x) => Number(x.costPerTask || 0).toFixed(5)],
      [t('evals.interventionRate', 'Intervene'), (x) => pct(x.interventionRate)],
      [t('evals.similarity', 'Similarity'), (x) => pct(x.similarity)],
      [t('evals.casesCol', 'Cases'), (x) => x.cases],
      ['Time', (x) => when(x.createdAt)],
    ]) : h('p.muted', {}, t('evals.noScores', 'No scores yet. Run the suite.')));

  const tuneOut = h('div');
  const renderEvaluations = (res) => {
    const rows = res.evaluations || [];
    tuneOut.replaceChildren(card(t('evals.proposals', 'Tune proposals'),
      h('p.small', {}, `${t('evals.baseline', 'Baseline score')}: ${pct(res.baseline?.score)} · ${t('evals.applied', 'auto-applied')}: ${(res.applied || []).length}`),
      rows.length ? table(rows, [
        [t('evals.kind', 'Kind'), (x) => h('code.small', {}, x.proposal.kind)],
        [t('common.description'), (x) => h('span.small', {}, x.proposal.summary)],
        [t('evals.candidate', 'Candidate'), (x) => pct(x.candidateScore)],
        [t('evals.improvement', 'Δ'), (x) => h('span.small', {}, `${x.improvement >= 0 ? '+' : ''}${pct(x.improvement)}`)],
        [t('evals.accepted', 'Accepted'), (x) => x.rejectedReason ? h('span.badge.off', {}, x.rejectedReason) : badge(x.accepted, t('evals.keep', 'improves'), t('evals.reject', 'rejected'))],
        ['', (x) => isAdmin() && x.accepted ? h('button.primary', { onclick: safe(async () => (await api(`/api/evals/suites/${sel.suiteId}/apply-tune`, { body: x }), toast(t('evals.tuneApplied', 'Tune applied')), reload())) }, t('evals.apply', 'Apply')) : null],
      ]) : h('p.muted', {}, t('evals.noProposals', 'No proposals generated.'))));
  };
  const actionsCard = isAdmin() ? card(t('evals.actions', 'Run & tune'),
    h('div.row', {},
      h('button.primary', { onclick: safe(async () => { const s = await api(`/api/evals/suites/${sel.suiteId}/run`, { body: {} }); toast(`${t('evals.ran', 'Suite scored')}: ${pct(s.score)}`); await reload(); }) }, t('evals.runSuite', 'Run suite')),
      h('button', { onclick: safe(async () => { const res = await api(`/api/evals/suites/${sel.suiteId}/tune`, { body: {} }); renderEvaluations(res); toast(t('evals.tuned', 'Proposals evaluated')); }) }, t('evals.proposeTune', 'Propose tune')),
      h('button', { onclick: safe(async () => { state.evalSel = {}; await reload(); }) }, t('evals.back', 'Back to suites'))),
    tuneOut) : null;

  const tunes = await api(`/api/evals/tunes?suiteId=${sel.suiteId}`).catch(() => ({ tunes: [] }));
  const tunesCard = card(t('evals.tuneHistory', 'Accepted tunes (versioned, reversible)'),
    tunes.tunes.length ? table(tunes.tunes, [
      ['v', (x) => x.version],
      [t('evals.kind', 'Kind'), (x) => h('code.small', {}, x.kind)],
      [t('common.description'), (x) => h('span.small', {}, x.summary)],
      [t('evals.candidate', 'Score'), (x) => pct(x.candidateScore)],
      [t('common.status'), (x) => badge(!x.reverted, x.status, t('evals.reverted', 'reverted'))],
      ['Time', (x) => when(x.createdAt)],
      ['', (x) => isAdmin() && !x.reverted ? h('button', { onclick: safe(async () => (await api(`/api/evals/tunes/${x.id}/revert`, { body: {} }), toast(t('evals.tuneReverted', 'Tune reverted')), reload())) }, t('evals.revert', 'Revert')) : null],
    ]) : h('p.muted', {}, t('evals.noTunes', 'No tunes accepted yet.')));

  return [statusCard, suitesCard, casesCard, addCaseCard, promoteCard, trendCard, actionsCard, tunesCard];
});

/**
 * Sharable Agent Bundles ("Mercury packs"): export the current config (skills, workflows,
 * personality, policy, MCP presets) as a single versioned, signed artifact; inspect one without
 * installing; and install into this instance in one step. Install verifies the signature (tamper
 * detection), checks version/compatibility, is idempotent, and routes governed sections
 * (policy / MCP presets) through the approval path instead of applying them silently.
 */
export const renderBundles = (view) => panel(view, t('bundles.title', 'Agent Bundles'), async (reload) => {
  const data = await api('/api/bundles').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('bundles.unavailable', 'bundles subsystem unavailable')));
  const SECTIONS = ['skills', 'workflows', 'personality', 'policy', 'mcp'];

  const statusCard = card(t('bundles.status', 'Status'),
    h('p.small.muted', {}, t('bundles.intro', 'Package a Mercury configuration — skills, workflows, personality, policy and MCP presets — into one versioned, signed artifact you can share. Installing verifies the signature, checks version/compatibility, is idempotent (same digest = no-op), and routes governed sections (policy, MCP) through approval instead of applying them silently.')),
    h('p', {}, t('common.status') + ': ', badge(data.enabled, t('bundles.on', 'bundles ON'), t('bundles.off', 'off')),
      h('span.small', {}, ` · ${t('bundles.requireSig', 'require signature')} ${data.config.requireSignature ? 'on' : 'off'} · ${t('bundles.autoPolicy', 'auto-approve policy')} ${data.config.autoApprovePolicy ? 'on' : 'off'} · ${t('bundles.autoMcp', 'auto-approve MCP')} ${data.config.autoApproveMcp ? 'on' : 'off'}`)));

  // ---- export ----
  const ei = { name: field(t('bundles.name', 'pack name'), { className: 'grow' }), version: field(t('bundles.version', 'version e.g. 1.0.0')), description: field(t('common.description'), { className: 'grow' }), author: field(t('bundles.author', 'author (optional)')) };
  const secBoxes = SECTIONS.map((s) => { const cb = h('input', { type: 'checkbox', checked: true }); return { s, label: h('label.small', {}, cb, ' ' + s), cb }; });
  const exportOut = h('div');
  const exportCard = isAdmin() ? card(t('bundles.export', 'Export a bundle'),
    h('div.row', {}, ...Object.values(ei)),
    h('div.row', {}, ...secBoxes.map((b) => b.label)),
    h('div.row', {}, h('button.primary', { onclick: safe(async () => {
      if (!ei.name.value) return toast(t('bundles.needName', 'name is required'), true);
      const sections = secBoxes.filter((b) => b.cb.checked).map((b) => b.s);
      const bundle = await api('/api/bundles/export', { body: { name: ei.name.value, version: ei.version.value || undefined, sections, description: ei.description.value || undefined, author: ei.author.value || undefined } });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${bundle.manifest.name}-${bundle.manifest.version}.mercury.json` }, `${t('bundles.download', 'Download')} ${bundle.manifest.name}-${bundle.manifest.version}.mercury.json`);
      exportOut.replaceChildren(card(t('bundles.exported', 'Exported & signed'),
        h('p.small', {}, `${t('bundles.sig', 'signature')}: `, h('code.small', {}, bundle.signature.slice(0, 24) + '…')),
        h('p.small', {}, `${t('bundles.sections', 'sections')}: ${bundle.manifest.sections.join(', ')}`), a));
      a.click();
      toast(t('bundles.exportedToast', 'Bundle exported'));
    }) }, t('bundles.exportBtn', 'Export & download'))),
    exportOut) : null;

  // ---- inspect / install ----
  const paste = field(t('bundles.paste', 'paste bundle JSON here, or choose a file'), { className: 'grow' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', onchange: safe(async (e) => { const f = e.target.files?.[0]; if (f) paste.value = await f.text(); }) });
  const ioOut = h('div');
  const readBundle = () => { try { return JSON.parse(paste.value); } catch { toast(t('bundles.badJson', 'bundle must be valid JSON'), true); return null; } };
  const installCard = card(t('bundles.install', 'Inspect / install a bundle'),
    h('p.small.muted', {}, t('bundles.installHelp', 'Inspect shows the manifest, whether the signature is valid and whether it is compatible — without changing anything. Install applies the ungoverned sections and queues policy/MCP for approval.')),
    h('div.row', {}, fileIn),
    h('div.row', {}, paste),
    h('div.row', {},
      h('button', { onclick: safe(async () => { const b = readBundle(); if (!b) return; const r = await api('/api/bundles/inspect', { body: b }); ioOut.replaceChildren(card(t('bundles.inspectResult', 'Inspect'),
        h('p.small', {}, `${r.manifest.name} v${r.manifest.version} · ${t('bundles.format', 'format')} ${r.manifest.formatVersion} · ${t('bundles.from', 'from Mercury')} ${r.manifest.mercuryVersion}`),
        h('p', {}, t('bundles.sigValid', 'Signature') + ': ', badge(r.signatureValid, t('bundles.valid', 'valid'), t('bundles.invalid', 'INVALID')), ' · ', t('bundles.compatible', 'Compatible') + ': ', badge(r.compatible, t('bundles.yes', 'yes'), t('bundles.no', 'no'))),
        h('p.small', {}, `${t('bundles.sections', 'sections')}: ${r.sections.join(', ')} · ${t('bundles.governed', 'governed')}: ${r.governed.join(', ') || '—'}`),
        r.issues.length ? h('p.small.muted', {}, t('bundles.issues', 'Issues') + ': ' + r.issues.join('; ')) : null,
        json({ digest: r.digest }))); }) }, t('bundles.inspectBtn', 'Inspect')),
      isAdmin() ? h('button.primary', { onclick: safe(async () => { const b = readBundle(); if (!b) return; const r = await api('/api/bundles/install', { body: { bundle: b, source: 'web-ui' } });
        ioOut.replaceChildren(card(t('bundles.installResult', 'Install'),
          h('p', {}, t('common.status') + ': ', badge(r.status !== 'rejected', r.status, r.status), r.alreadyInstalled ? ' · ' + t('bundles.idempotent', 'already installed (no-op)') : ''),
          h('p.small', {}, `${t('bundles.applied', 'applied')}: ${r.applied.join(', ') || '—'} · ${t('bundles.pending', 'pending approval')}: ${r.pending.join(', ') || '—'}`),
          r.issues.length ? h('p.small.muted', {}, t('bundles.issues', 'Issues') + ': ' + r.issues.join('; ')) : null));
        toast(`${t('bundles.installed', 'Installed')}: ${r.status}`); await reload(); }) }, t('bundles.installBtn', 'Install')) : null),
    ioOut);

  const installedCard = card(t('bundles.installed', 'Installed bundles'),
    data.installed.length ? table(data.installed, [
      [t('bundles.name', 'Name'), (x) => h('code', {}, x.name)],
      [t('bundles.version', 'Ver'), (x) => x.version],
      [t('bundles.digest', 'Digest'), (x) => h('code.small', {}, (x.digest || '').slice(0, 12))],
      [t('common.status'), (x) => badge(x.status !== 'rejected', x.status, x.status)],
      [t('bundles.applied', 'Applied'), (x) => h('span.small', {}, (x.applied || []).join(', ') || '—')],
      [t('bundles.pending', 'Pending'), (x) => h('span.small', {}, (x.pending || []).join(', ') || '—')],
      ['Time', (x) => when(x.updatedAt || x.createdAt)],
      ['', (x) => isAdmin() && (x.pending || []).length ? h('button.primary', { onclick: safe(async () => (await api(`/api/bundles/${x.id}/approve`, { body: {} }), toast(t('bundles.approved', 'Governed sections approved')), reload())) }, t('bundles.approve', 'Approve')) : null],
    ]) : h('p.muted', {}, t('bundles.noneInstalled', 'No bundles installed yet.')));

  return [statusCard, exportCard, installCard, installedCard];
});

export const renderTeams = (view) => panel(view, t('teams.title', 'Teams'), async (reload) => {
  const data = await api('/api/teams').catch(() => null);
  if (!data) return card(null, h('p.muted', {}, t('teams.unavailable', 'teams subsystem unavailable')));
  const teams = data.teams || [];
  const runs = (await api('/api/teams/runs').catch(() => ({ runs: [] }))).runs || [];

  const statusCard = card(t('teams.status', 'Status'),
    h('p.small.muted', {}, t('teams.intro', 'Compose role-specialised agents into governed, budget-aware runs with a coordinator, pipeline or debate strategy.')));

  // ---- create ----
  const ci = {
    name: field(t('teams.name', 'team name'), { className: 'grow' }),
    strategy: h('select', {}, ...['coordinator', 'pipeline', 'debate'].map((s) => h('option', { value: s }, s))),
    members: field(t('teams.members', 'members: role1:goal1; role2:goal2'), { className: 'grow' }),
  };
  const createCard = isAdmin() ? card(t('teams.create', 'Create team'),
    h('div.row', {}, ci.name, ci.strategy),
    h('div.row', {}, ci.members),
    h('div.row', {}, h('button.primary', { onclick: safe(async () => {
      if (!ci.name.value) return toast(t('teams.needName', 'name is required'), true);
      const members = ci.members.value.split(';').map((s) => s.trim()).filter(Boolean).map((spec) => {
        const [role, task] = spec.split(':');
        return { name: (role || 'member').trim(), role: (role || 'member').trim(), task: (task || '').trim() || undefined };
      });
      await api('/api/teams', { body: { name: ci.name.value, strategy: ci.strategy.value, members } });
      toast(t('teams.created', 'Team created'));
      await reload();
    }) }, t('teams.createBtn', 'Create')))) : null;

  // ---- run ----
  const runOut = h('div');
  const ri = { team: field(t('teams.name', 'team name or id')), task: field(t('teams.task', 'task'), { className: 'grow' }), budget: field(t('teams.budget', 'budget (optional)')) };
  const runCard = card(t('teams.run', 'Run a team'),
    h('div.row', {}, ri.team, ri.budget),
    h('div.row', {}, ri.task),
    h('div.row', {}, h('button.primary', { onclick: safe(async () => {
      if (!ri.team.value || !ri.task.value) return toast(t('teams.needRun', 'team and task are required'), true);
      const rec = await api(`/api/teams/${encodeURIComponent(ri.team.value)}/run`, { body: { task: ri.task.value, budget: ri.budget.value ? Number(ri.budget.value) : undefined, approve: true } });
      runOut.replaceChildren(card(t('teams.result', 'Run result'),
        h('p', {}, t('common.status') + ': ', badge(rec.status === 'completed', rec.status, rec.status), ` · cost=${rec.cost}`),
        json(rec.trace),
        h('pre.small', {}, rec.output)));
      await reload();
    }) }, t('teams.runBtn', 'Run'))),
    runOut);

  const teamsCard = card(t('teams.title', 'Teams'),
    teams.length ? table(teams, [
      [t('teams.name', 'Name'), (x) => h('code', {}, x.name)],
      [t('teams.strategy', 'Strategy'), (x) => x.strategy],
      [t('teams.members', 'Members'), (x) => (x.members || []).length],
      ['', (x) => isAdmin() ? h('button', { onclick: safe(async () => (await api(`/api/teams/${encodeURIComponent(x.id)}`, { method: 'DELETE' }), toast(t('teams.deleted', 'Deleted')), reload())) }, t('teams.delete', 'Delete')) : null],
    ]) : h('p.muted', {}, t('teams.none', 'No teams defined yet.')));

  const runsCard = card(t('teams.runs', 'Recent runs'),
    runs.length ? table(runs, [
      [t('teams.name', 'Team'), (x) => x.teamName],
      [t('common.status'), (x) => badge(x.status === 'completed', x.status, x.status)],
      [t('teams.budget', 'Cost'), (x) => x.cost],
      ['Time', (x) => when(x.startedAt)],
    ]) : h('p.muted', {}, t('teams.noRuns', 'No runs yet.')));

  return [statusCard, createCard, runCard, teamsCard, runsCard];
});
