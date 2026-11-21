/** Panels: scheduler, integrations, models/router/budgets/Jev, users, observability/debug, reflections, help, account. */
import { api, badge, h, json, markdown, safe, state, t, table, toast, when } from './core.js';

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
    const taskEdit = field(t('scheduler.task'), { value: s.task, className: 'grow' });
    const save = safe(async () => {
      await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { name: nameIn.value, when: whenEdit.value, task: taskEdit.value } });
      editor.replaceChildren();
      toast(t('common.saved'));
      await reload();
    });
    editor.replaceChildren(card(`${t('common.edit', 'Edit')}: ${s.name}`,
      h('div.row', {}, nameIn, whenEdit, taskEdit),
      h('div.row', {}, h('button.primary', { onclick: save }, t('common.save', 'Save')),
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
