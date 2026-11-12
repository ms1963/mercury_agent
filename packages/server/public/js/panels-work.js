/** Panels: sessions, runs (agent/subagent viewer), workflows, memory, skills, tools & MCP. */
import { api, badge, h, json, safe, stream, t, table, toast, when } from './core.js';
import { openSession } from './chat.js';

const field = (placeholder, attrs = {}) => h('input', { placeholder, ...attrs });
const refreshBtn = (fn) => h('button', { onclick: safe(fn) }, t('common.refresh'));

export async function renderSessions(view, go) {
  const q = field(t('common.search'));
  const list = h('div');
  const load = async () => {
    const r = await api(`/api/sessions${q.value ? `?q=${encodeURIComponent(q.value)}` : ''}`);
    const rows = r.sessions ?? r.hits.map((x) => ({ id: x.sessionId, title: `${x.title} — ${x.snippet}`, updated_at: x.createdAt }));
    list.replaceChildren(table(rows, [
      [t('common.name'), (s) => s.title || s.id],
      ['Platform', (s) => s.platform],
      ['Updated', (s) => when(s.updated_at)],
      [t('common.actions'), (s) => h('span', {},
        h('button', { onclick: () => (openSession(s.id), go('chat')) }, t('sessions.continue')),
        h('button', { onclick: safe(async () => { const title = prompt(t('sessions.rename'), s.title || ''); if (title !== null) (await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { title } }), load()); }) }, t('sessions.rename')),
        h('button.danger', { onclick: safe(async () => confirm(t('common.confirmDelete')) && (await api(`/api/sessions/${s.id}`, { method: 'DELETE' }), load())) }, t('common.delete')))],
    ]));
  };
  q.onkeydown = (e) => e.key === 'Enter' && safe(load)();
  view.append(h('h2', {}, t('sessions.title')), h('div.row', {}, q, refreshBtn(load)), h('div.card', {}, list));
  await load();
}

export async function renderRuns(view) {
  const detail = h('div');
  const showRun = async (id) => {
    const r = await api(`/api/runs/${id}/events`);
    detail.replaceChildren(h('div.card', {},
      h('h3', {}, `${t('runs.events')} — ${id}`),
      r.children.length ? h('p', {}, `${t('runs.children')}: `, r.children.map((c) => h('a', { href: '#', onclick: (e) => (e.preventDefault(), safe(showRun)(c.id)) }, `${c.id} (${c.kind}, ${c.status}) `))) : null,
      table(r.events, [['Time', (e) => new Date(e.ts).toLocaleTimeString()], ['Type', (e) => h('code', {}, e.type)], ['Data', (e) => h('div.small', {}, JSON.stringify(e.data).slice(0, 300))]])));
  };
  const r = await api('/api/runs');
  view.append(h('h2', {}, t('runs.title')), h('div.card', {}, table(r.runs, [
    ['Run', (x) => h('a', { href: '#', onclick: (e) => (e.preventDefault(), safe(showRun)(x.id)) }, x.id)],
    ['Kind', (x) => x.kind], ['Parent', (x) => x.parent_run_id], [t('common.status'), (x) => x.status],
    ['Model', (x) => x.model], ['Started', (x) => when(x.started_at)],
  ])), detail);
}

export async function renderWorkflows(view) {
  const r = await api('/api/workflows');
  const out = h('div.events');
  const result = h('div');
  const run = (name) => safe(async () => {
    const input = prompt(`${t('workflows.runWorkflow')}: ${name}\n${t('common.input')}:`);
    if (input === null) return;
    out.replaceChildren();
    result.replaceChildren(h('p.muted', {}, t('chat.thinking')));
    await stream(`/api/workflows/${encodeURIComponent(name)}/run`, { input }, (type, d) => {
      if (type === 'event') out.append(h('div', {}, `${new Date(d.ts).toLocaleTimeString()} ${d.type} ${JSON.stringify(d.data).slice(0, 160)}`));
      if (type === 'done') result.replaceChildren(h('h3', {}, t('common.output')), json(d.output), h('h3', {}, t('workflows.steps')), table(d.steps, [['Agent', (s) => s.agent], [t('common.status'), (s) => s.status], [t('common.output'), (s) => h('div.small', {}, String(s.output).slice(0, 400))]]));
      if (type === 'error') result.replaceChildren(h('p.error', {}, d.error));
      out.scrollTop = out.scrollHeight;
    });
  });
  view.append(
    h('h2', {}, t('workflows.title')),
    h('div.card', {}, table(r.workflows, [[t('common.name'), (w) => w.name], ['Type', (w) => w.type], [t('common.description'), (w) => w.description], [t('common.actions'), (w) => h('button.primary', { onclick: run(w.name) }, t('common.run'))]])),
    h('div.card', {}, h('h3', {}, t('workflows.templates')), table(r.templates, [['Type', (x) => x.type], [t('common.description'), (x) => x.description]])),
    h('div.card', {}, h('h3', {}, t('runs.live')), out), result);
}

export async function renderMemory(view) {
  const q = field(t('common.search'));
  const body = h('div');
  const load = async () => {
    const r = await api(`/api/memory${q.value ? `?q=${encodeURIComponent(q.value)}` : ''}`);
    const editor = (which, label) => {
      const ta = h('textarea', { rows: 8, value: r.curated[which] ?? '' });
      return h('div.card', {}, h('h3', {}, label), ta, h('button.primary', { onclick: safe(async () => (await api(`/api/memory/curated/${which}`, { method: 'PUT', body: { content: ta.value } }), toast(t('common.saved')))) }, t('common.save')));
    };
    const add = field(t('memory.add'), { className: 'grow' });
    body.replaceChildren(
      h('div.card', {}, h('h3', {}, t('memory.facts')),
        h('div.row', {}, add, h('button.primary', { onclick: safe(async () => add.value && (await api('/api/memory', { body: { content: add.value } }), load())) }, t('memory.add'))),
        table(r.facts, [['Fact', (f) => f.content ?? f.text], ['Kind', (f) => f.kind], ['Score', (f) => (f.score !== undefined ? Number(f.score).toFixed(2) : '')], ['', (f) => h('button.danger', { onclick: safe(async () => (await api(`/api/memory/${f.id}`, { method: 'DELETE' }), load())) }, '×')]])),
      h('div.grid2', {}, editor('memory', t('memory.agentNotes')), editor('user', t('memory.userNotes'))),
      h('div.card', {}, h('h3', {}, t('memory.profile')), json(r.profile), h('p.small.muted', {}, `Providers: ${r.providers.join(', ')}`)));
  };
  q.onkeydown = (e) => e.key === 'Enter' && safe(load)();
  view.append(h('h2', {}, t('memory.title')), h('div.row', {}, q, refreshBtn(load)), body);
  await load();
}

export async function renderSkills(view) {
  const list = h('div');
  const detail = h('div');
  const load = async () => {
    const r = await api('/api/skills');
    list.replaceChildren(table(r.skills, [
      [t('common.name'), (s) => h('a', { href: '#', onclick: (e) => (e.preventDefault(), safe(open)(s.name)) }, s.name)],
      [t('common.description'), (s) => s.description], ['Source', (s) => s.source], ['Uses', (s) => s.stats?.uses ?? ''],
    ]));
  };
  const open = async (name) => {
    const r = await api(`/api/skills/${encodeURIComponent(name)}`);
    const ta = h('textarea', { rows: 16, value: r.body ?? '' });
    detail.replaceChildren(h('div.card', {}, h('h3', {}, name), ta, h('p.small.muted', {}, (r.files || []).join(', ')),
      h('button.primary', { onclick: safe(async () => (await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: { body: ta.value } }), toast(t('common.saved')))) }, t('common.save'))));
  };
  const src = field(t('skills.install'), { className: 'grow' });
  const name = field(t('common.name'));
  const desc = field(t('common.description'), { className: 'grow' });
  const body = h('textarea', { rows: 5, placeholder: t('skills.body') });
  view.append(h('h2', {}, t('skills.title')), h('div.card', {}, list),
    h('div.card', {}, h('div.row', {}, src, h('button', { onclick: safe(async () => (toast(JSON.stringify((await api('/api/skills', { body: { source: src.value } })).installed)), load())) }, t('common.create')))),
    h('div.card', {}, h('h3', {}, t('skills.new')), h('div.row', {}, name, desc), body, h('button.primary', { onclick: safe(async () => (await api('/api/skills', { body: { name: name.value, description: desc.value, body: body.value } }), load())) }, t('common.create'))),
    detail);
  await load();
}

export async function renderTools(view) {
  const body = h('div');
  const load = async () => {
    const [r, mcp] = await Promise.all([api('/api/tools'), api('/api/mcp')]);
    const toggle = (payload) => safe(async () => (await api('/api/tools/toggle', { body: payload }), load()));
    const runTool = (name) => safe(async () => {
      const args = prompt(`${name} — ${t('tools.args')}`, '{}');
      if (args !== null) toast((await api(`/api/tools/${name}/run`, { body: JSON.parse(args || '{}') })).content.slice(0, 600));
    });
    const transport = h('select', {}, ['stdio', 'http', 'sse'].map((v) => h('option', { value: v }, v)));
    const mName = field(t('common.name'));
    const target = field(`${t('tools.command')} / ${t('tools.url')}`, { className: 'grow' });
    const connect = safe(async () => {
      const [cmd, ...args] = target.value.split(' ');
      const http = transport.value !== 'stdio';
      await api('/api/mcp', { body: { name: mName.value, config: { transport: transport.value, command: http ? undefined : cmd, args: http ? [] : args, url: http ? target.value : undefined, env: {}, headers: {}, include: [], exclude: [], trust: 'untrusted', allowSampling: false } } });
      load();
    });
    body.replaceChildren(
      h('div.card', {}, h('h3', {}, t('tools.toolsets')), table(r.toolsets, [[t('common.name'), (s) => s.name], ['Tools', (s) => s.tools.length], [t('common.status'), (s) => badge(s.enabled)], ['', (s) => h('button', { onclick: toggle({ toolset: s.name, enabled: !s.enabled }) }, s.enabled ? t('common.disable') : t('common.enable'))]])),
      h('div.card', {}, h('h3', {}, t('tools.mcpServers')), mcp.serverEndpoint ? h('p.small', {}, 'Mercury MCP endpoint: ', h('code', {}, location.origin + mcp.serverEndpoint)) : null,
        table(mcp.servers, [[t('common.name'), (s) => s.name], [t('common.status'), (s) => badge(s.connected)], ['Tools', (s) => h('span.small', { title: s.error ?? '' }, s.error ? `error: ${s.error}` : s.tools.length)], ['', (s) => h('button.danger', { onclick: safe(async () => (await api(`/api/mcp/${s.name}`, { method: 'DELETE' }), load())) }, '×')]]),
        h('div.row', {}, mName, transport, target, h('button.primary', { onclick: connect }, t('tools.connect')))),
      h('div.card', {}, h('h3', {}, t('tools.title')), table(r.tools, [[t('common.name'), (x) => h('code', {}, x.name)], ['Toolset', (x) => x.toolset], [t('tools.risk'), (x) => x.risk], [t('common.description'), (x) => h('span.small', {}, x.description)], [t('common.status'), (x) => badge(x.enabled)],
        ['', (x) => h('span', {}, h('button', { onclick: toggle({ tool: x.name, enabled: !x.enabled }) }, x.enabled ? t('common.disable') : t('common.enable')), h('button', { onclick: runTool(x.name) }, t('common.run')))]])));
  };
  view.append(h('h2', {}, t('nav.tools')), body);
  await load();
}
