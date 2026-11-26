/** Administrative subcommands (users, tokens, tools, skills, schedules, config, doctor, import...). */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditCoordinates, exitCodeFor, extractNpmCoordinates, fetchHttpClient, getPath, installSkills, mcpServerCoordinates, mercuryHome, pluginCoordinates, resolveVoicePreset, runEvalSuite, scaffold, scaffoldAddin, selectEvals, setConfigValue, voicePresets, type Coordinate, type EvalObservation, type ExtensionKind, type PackageJsonLike, type PluginPkg, type VoiceKind } from '@mercury/core';
import type { Mercury } from '@mercury/runtime';
import { enablePresetConfig, mcpPreset, mcpPresets } from '@mercury/mcp';
import { flag, type Args } from './args.js';

const out = (v: unknown, json?: boolean) => console.log(json || typeof v !== 'string' ? JSON.stringify(v, null, 2) : v);
const need = (v: string | undefined, usage: string): string => {
  if (!v) throw new Error(`usage: ${usage}`);
  return v;
};

export async function userCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', name, pw] = a._;
  // The operator performing the change (for the audit trail). When the store is empty
  // (bootstrapping the very first user) there is no operator yet, so the new user is
  // recorded as its own actor.
  const operator = m.users.count() > 0 ? m.principalFor(flag(a, 'user')).userId : undefined;
  switch (sub) {
    case 'list':
      return out(m.users.list().map((u) => `${u.username.padEnd(20)} ${u.role.padEnd(6)} ${u.disabled ? 'disabled' : ''}`).join('\n') || '(no users)');
    case 'add': {
      const u = m.users.register(need(name, 'mercury user add <name> <password> [--admin]'), need(pw, 'mercury user add <name> <password>'), { role: a.flags.admin ? 'admin' : 'user' }, operator);
      return out(`created ${u.username} (${u.role})`);
    }
    case 'passwd': {
      const u = m.users.findByUsername(need(name, 'mercury user passwd <name> <password>'));
      if (!u) throw new Error('unknown user');
      m.users.setPassword(u.id, need(pw, 'mercury user passwd <name> <password>'));
      return out('password updated');
    }
    case 'role': {
      const u = m.users.findByUsername(need(name, 'mercury user role <name> admin|user'));
      if (!u) throw new Error('unknown user');
      m.users.update(u.id, { role: need(pw, 'mercury user role <name> admin|user') as 'admin' | 'user' }, operator);
      return out('role updated');
    }
    case 'delete': {
      const u = m.users.findByUsername(need(name, 'mercury user delete <name>'));
      if (u) m.users.delete(u.id, operator);
      return out('deleted');
    }
    default:
      throw new Error('usage: mercury user list|add|passwd|role|delete');
  }
}

export async function tokenCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', arg] = a._;
  const p = m.principalFor(flag(a, 'user'));
  if (sub === 'create') {
    const scopes = (flag(a, 'scopes') ?? 'chat').split(',');
    const r = m.users.createToken(p.userId, need(arg, 'mercury token create <name> [--scopes chat,mcp]'), scopes, flag(a, 'days') ? Number(flag(a, 'days')) : undefined, p.userId);
    return out(`${r.token}\n(store it now — it is shown only once; scopes: ${scopes.join(',')})`);
  }
  if (sub === 'revoke') return (m.users.revokeToken(need(arg, 'mercury token revoke <id>'), p.userId), out('revoked'));
  return out(m.users.listTokens(p.userId), true);
}

export async function auditCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list'] = a._;
  if (sub === 'verify') return out(m.audit.verify(), true);
  const limit = flag(a, 'limit') ? Number(flag(a, 'limit')) : 100;
  const { entries, total } = m.audit.query({
    actor: flag(a, 'actor'),
    action: flag(a, 'action'),
    target: flag(a, 'target'),
    since: flag(a, 'since'),
    until: flag(a, 'until'),
    limit,
    offset: flag(a, 'offset') ? Number(flag(a, 'offset')) : 0,
  });
  if (a.flags.json) return out({ total, entries }, true);
  const lines = entries.map((e) => `${e.ts}  ${String(e.actor).padEnd(24)} ${e.action.padEnd(20)} ${e.target ?? ''}`);
  return out(`${lines.join('\n') || '(no matching entries)'}\n\n${entries.length} of ${total} shown`);
}

export async function toolsCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', name] = a._;
  if (sub === 'enable' || sub === 'disable') {
    const key = m.tools.get(need(name, `mercury tools ${sub} <tool|toolset>`)) ? `tools.disabled` : `tools.toolsets.${name}`;
    if (key === 'tools.disabled') {
      const set = new Set(m.config.tools.disabled);
      if (sub === 'disable') set.add(name!);
      else set.delete(name!);
      setConfigValue(key, [...set], m.configFile);
    } else setConfigValue(key, sub === 'enable', m.configFile);
    return out(`${name} ${sub}d (saved to config)`);
  }
  if (sub === 'toolsets') return out(m.tools.toolsets().map((t) => `${t.name.padEnd(14)} ${t.enabled ? 'on ' : 'off'} ${t.tools} tools`).join('\n'));
  return out(m.tools.list().map((t) => `${t.name.padEnd(22)} ${t.toolset.padEnd(12)} ${m.tools.isEnabled(t) ? '' : '(disabled)'}`).join('\n') + `\n${m.tools.list().length} tools`);
}

export async function skillsCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', arg] = a._;
  if (sub === 'view') return out(m.skills.view(need(arg, 'mercury skills view <name>')));
  if (sub === 'install') return out(`installed: ${installSkills(m.skills, need(arg, 'mercury skills install <folder|git-url>')).join(', ')}`);
  return out(m.skills.list().map((s) => `${s.meta.name.padEnd(24)} ${s.meta.description}`).join('\n') || '(no skills)');
}

export async function scheduleCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', ...rest] = a._;
  const p = m.principalFor(flag(a, 'user'));
  switch (sub) {
    case 'add': {
      const when = need(flag(a, 'when'), 'mercury schedule add --when "every day at 9am" <task...> [--deliver telegram:123]');
      const deliver = flag(a, 'deliver')?.split(':');
      const s = m.scheduler.create(p.userId, { when, task: need(rest.join(' '), 'task text'), delivery: deliver ? { platform: deliver[0]!, target: deliver.slice(1).join(':') } : undefined });
      return out(`created ${s.id}: ${s.kind} ${s.spec} → next ${s.nextRun}`);
    }
    case 'edit':
    case 'update': {
      const id = need(rest[0], 'mercury schedule edit <id> [--when "..."] [--name "..."] [--task "..."] [--deliver platform:target] [--max-retries N]');
      const patch: Record<string, unknown> = {};
      if (flag(a, 'when')) patch.when = flag(a, 'when');
      if (flag(a, 'name')) patch.name = flag(a, 'name');
      // Task text may be given via --task or as trailing words after the id.
      const taskText = flag(a, 'task') ?? (rest.length > 1 ? rest.slice(1).join(' ') : undefined);
      if (taskText) patch.task = taskText;
      if (flag(a, 'deliver')) { const d = flag(a, 'deliver')!.split(':'); patch.delivery = { platform: d[0]!, target: d.slice(1).join(':') }; }
      if (flag(a, 'max-retries')) patch.maxRetries = Number(flag(a, 'max-retries'));
      if (!Object.keys(patch).length) throw new Error('nothing to change — pass at least one of --when, --name, --task, --deliver, --max-retries');
      const s = m.scheduler.update(id, patch, p.userId);
      return out(`updated ${s.id}: ${s.kind} ${s.spec} → next ${s.nextRun}`);
    }
    case 'pause':
      return out(m.scheduler.pause(need(rest[0], 'id'), p.userId), true);
    case 'resume':
      return out(m.scheduler.resume(need(rest[0], 'id'), p.userId), true);
    case 'delete':
      return (m.scheduler.delete(need(rest[0], 'id'), p.userId), out('deleted'));
    case 'run':
      return out(await m.scheduler.runNow(need(rest[0], 'id'), p.userId), true);
    default:
      return out(m.scheduler.list(p.userId).map((s) => `${s.id}  ${s.status.padEnd(6)} ${s.spec.padEnd(18)} next=${s.nextRun ?? '-'}  ${s.task.slice(0, 50)}`).join('\n') || '(no schedules)');
  }
}

/**
 * `mercury voice ...` — inspect and swap the speech stack in one declarative step.
 *   voice presets                 List built-in STT/TTS presets (online + offline).
 *   voice show                    Show the current voice.stt / voice.tts config.
 *   voice use <stt|tts> <name>    Apply a preset (writes the whole voice.<kind> block).
 */
export function voiceCmd(m: Mercury, a: Args): void {
  const [, sub, kindArg, name] = a._;
  if (sub === 'show') return out({ stt: m.config.voice.stt, tts: m.config.voice.tts }, true);
  if (sub === 'use') {
    const kind = need(kindArg, 'mercury voice use <stt|tts> <preset>') as VoiceKind;
    if (kind !== 'stt' && kind !== 'tts') throw new Error('kind must be "stt" or "tts"');
    const patch = resolveVoicePreset(kind, need(name, `mercury voice use ${kind} <preset>`));
    const file = setConfigValue(`voice.${kind}`, patch, m.configFile);
    return out(`✔ ${kind.toUpperCase()} preset "${name}" applied → ${file}\n${JSON.stringify(patch)}`);
  }
  // Default: list presets for both kinds.
  const lines: string[] = [];
  for (const kind of ['stt', 'tts'] as VoiceKind[]) {
    lines.push(`${kind.toUpperCase()} presets:`);
    for (const [id, p] of Object.entries(voicePresets(kind))) {
      lines.push(`  ${id.padEnd(10)} [${p.reach}, ${p.openSource ? 'open-source' : 'commercial'}]  ${p.description}`);
    }
  }
  lines.push('\nApply with:  mercury voice use <stt|tts> <name>');
  return out(lines.join('\n'));
}

export async function configCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'path', key, value] = a._;
  if (sub === 'get') return out(key ? getPath(m.config, key) ?? '(unset)' : m.config, true);
  if (sub === 'set') {
    const { coerceValue } = await import('@mercury/core');
    return out(`saved to ${setConfigValue(need(key, 'mercury config set <key> <value>'), coerceValue(need(value, 'value')), m.configFile)}`);
  }
  return out(m.configFile ?? `(no config file; defaults in use — will be written to ${join(mercuryHome(), 'config.yaml')})`);
}

export async function gatewayCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'status', code] = a._;
  if (sub === 'pair') {
    const operator = m.principalFor(flag(a, 'user')).userId;
    const r = m.pairing.approve(need(code, 'mercury gateway pair <CODE> [--user name]'), operator, operator);
    return out(`linked ${r.platform}:${r.externalId}`);
  }
  if (sub === 'pending') return out(m.pairing.listPending(), true);
  if (sub === 'start') {
    await m.gateway.start();
    out(m.gateway.status(), true);
    console.log('Gateway running. Press Ctrl+C to stop.');
    await new Promise(() => undefined);
  }
  return out({ enabled: m.config.gateway.enabled, configured: Object.keys(m.config.gateway.adapters), running: m.gateway.status() }, true);
}

/** Environment checks with actionable hints. */
export async function doctor(m: Mercury): Promise<void> {
  const has = (bin: string, arg = '--version') => spawnSync(bin, [arg], { stdio: 'ignore' }).status === 0;
  const checks: Array<[string, boolean, string]> = [
    ['Node.js >= 22', Number(process.versions.node.split('.')[0]) >= 22, 'install Node 22+'],
    ['data dir writable', existsSync(m.config.dataDir), m.config.dataDir],
    ['users exist', m.users.count() > 0, 'run `mercury setup`'],
    ['real LLM provider (REQUIRED)', m.providers.list().some((p) => p.id !== 'mock'), 'run `mercury setup`, or configure chatllm / openrouter / ollama / lmstudio / openai-compatible / anthropic (see docs/PROVIDERS.md)'],
    ['Jev decisions (optional, OPENROUTER_API_KEY)', m.decisions.chain()[0] === 'jev', `optional; current chain: ${m.decisions.chain().join(' → ')}`],
    ['python3 (execute_code, polyglot)', has('python3'), 'optional'],
    ['docker (terminal backend)', has('docker'), 'optional'],
    ['ffmpeg (video/audio)', has('ffmpeg', '-version'), 'optional'],
    ['git (skills install, update)', has('git'), 'optional'],
  ];
  for (const [name, ok, hint] of checks) console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${hint}`}`);
  console.log(`\n${m.tools.list().length} tools · ${m.skills.list().length} skills · ${m.workflows.list().length} workflows · decision chain: ${m.decisions.chain().join(' → ')}`);
}

/** Import from a Hermes Agent home (~/.hermes): memories, user profile, skills and model. */
export async function importAgent(m: Mercury, a: Args): Promise<void> {
  const src = a._[1] ?? join(homedir(), '.hermes');
  if (!existsSync(src)) throw new Error(`${src} not found`);
  const p = m.principalFor(flag(a, 'user'));
  const done: string[] = [];
  for (const [file, which] of [['MEMORY.md', 'memory'], ['USER.md', 'user']] as const) {
    for (const f of [join(src, file), join(src, 'memories', file)]) {
      if (existsSync(f)) {
        m.memory.curated.write(p.userId, which, readFileSync(f, 'utf8'));
        done.push(file);
        break;
      }
    }
  }
  const skillsDir = join(src, 'skills');
  if (existsSync(skillsDir)) done.push(`skills: ${installSkills(m.skills, skillsDir).length}`);
  const cfg = join(src, 'config.yaml');
  if (existsSync(cfg)) {
    const model = /^\s*(?:model|default_model):\s*["']?([^"'\n]+)/m.exec(readFileSync(cfg, 'utf8'))?.[1];
    if (model) done.push(`model hint: ${model} (set with \`mercury model <provider/model>\`)`);
  }
  out(done.length ? `Imported: ${done.join(', ')}` : 'Nothing to import found.');
}

export async function newCmd(a: Args): Promise<void> {
  const [, kind, name] = a._;
  const r = scaffold(need(kind, 'mercury new tool|skill|workflow|adapter|plugin <name> [--lang python|js|go|cpp|java]') as ExtensionKind, need(name, 'name'), flag(a, 'dir') ?? mercuryHome(), { language: flag(a, 'lang') as never });
  out(`Created ${r.path}\n${r.files.map((f) => `  ${f}`).join('\n')}\nSee docs/EXTENDING.md. Tools and skills hot-reload; restart for plugins/adapters.`);
}

export async function updateCmd(m: Mercury): Promise<void> {
  const root = m.assets;
  if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git checkout; reinstall with install.sh`);
  for (const [cmd, args] of [['git', ['pull', '--ff-only']], ['npm', ['install']], ['npm', ['run', 'build']]] as const) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, [...args], { cwd: root, stdio: 'inherit' });
  }
  out('Updated. Config migrations run automatically on next start.');
}

export function pluginsCmd(m: Mercury): void {
  const dir = join(m.config.dataDir, 'plugins');
  out(m.plugins.length ? m.plugins.map((p) => `${p.name} ${p.version ?? ''} ${p.error ? `ERROR: ${p.error}` : ''}`).join('\n') : `(no plugins; put them in ${dir}${existsSync(dir) ? `, found: ${readdirSync(dir).join(', ')}` : ''})`);
}

export function copyAssets(from: string, to: string): void {
  cpSync(from, to, { recursive: true, errorOnExist: false });
}

/**
 * `mercury eval` — run the built-in deterministic self-evaluation suite against the
 * configured provider (the offline mock when MERCURY_ENABLE_MOCK=1) and report
 * pass/score plus token and estimated-cost accounting derived from the event bus.
 */
export async function evalCmd(m: Mercury, a: Args): Promise<void> {
  const principal = await m.localPrincipal();
  const tag = flag(a, 'tag');
  const tasks = selectEvals(tag);
  if (tasks.length === 0) throw new Error(`no eval tasks match tag "${tag}"`);

  // Accumulate per-run token usage and estimated cost straight off the event bus.
  const usage = new Map<string, { inputTokens: number; outputTokens: number; cost: number }>();
  const offUsage = m.bus.on('llm.response', (e) => {
    const id = e.runId ?? '';
    const acc = usage.get(id) ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
    const d = e.data as { inputTokens?: number; outputTokens?: number; cost?: number };
    acc.inputTokens += d.inputTokens ?? 0;
    acc.outputTokens += d.outputTokens ?? 0;
    acc.cost += d.cost ?? 0;
    usage.set(id, acc);
  });

  try {
    const report = await runEvalSuite(tasks, async (task): Promise<EvalObservation> => {
      const started = Date.now();
      const res = await m.commands.handle({ principal, input: task.prompt, platform: 'cli' });
      const durationMs = Date.now() - started;
      const u = usage.get(res.run?.runId ?? '') ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
      return { output: res.output ?? '', toolNames: res.run?.toolNames ?? [], inputTokens: u.inputTokens, outputTokens: u.outputTokens, cost: u.cost, durationMs };
    });

    if (a.flags.json) return out(report, true);

    const rows = report.results.map(
      (r) => `${(r.pass ? 'PASS' : 'FAIL').padEnd(5)} ${r.id.padEnd(26)} score=${r.score.toFixed(2)}  tok=${r.inputTokens}/${r.outputTokens}  $${r.cost.toFixed(6)}  ${r.durationMs}ms${r.pass ? '' : `  — ${r.reasons.join('; ')}`}`,
    );
    out(
      `Mercury self-evaluation${tag ? ` (tag: ${tag})` : ''}\n${rows.join('\n')}\n\n` +
        `${report.passed}/${report.total} passed  mean-score=${report.score.toFixed(2)}  tokens=${report.inputTokens}/${report.outputTokens}  est-cost=$${report.cost.toFixed(6)}  ${report.durationMs}ms`,
    );
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    offUsage();
  }
}

export async function wikiCmd(m: Mercury, a: Args): Promise<void> {
  const wiki = m.wiki;
  const [, sub = 'status', arg] = a._;
  switch (sub) {
    case 'init': {
      await wiki.init();
      return out(`Wiki initialised at ${wiki.dir}`);
    }
    case 'status': {
      const s = await wiki.status();
      if (!s.initialized) return out(`Wiki not initialised (dir: ${s.dir}). Run \`mercury wiki init\`.`);
      return out(
        `Wiki: ${s.dir}\n  pages:   ${s.pages}\n  sources: ${s.sources}\n  last ingest: ${s.lastIngestAt ?? '(never)'}\n  last lint:   ${s.lastLintAt ?? '(never)'}`,
      );
    }
    case 'ingest': {
      const src = need(arg, 'mercury wiki ingest <path|->');
      const name = flag(a, 'name');
      const instruction = flag(a, 'instruction');
      const res = src === '-'
        ? await wiki.ingest(readFileSync(0, 'utf8'), { asText: true, name: name ?? 'stdin.md', instruction })
        : await wiki.ingest(src, { name, instruction });
      const parts = [`Ingested ${res.source}.`];
      if (res.created.length) parts.push(`Created: ${res.created.join(', ')}.`);
      if (res.updated.length) parts.push(`Updated: ${res.updated.join(', ')}.`);
      return out(parts.join(' '));
    }
    case 'query': {
      const q = need(arg, 'mercury wiki query "<question>"');
      const res = await wiki.query(q, { k: flag(a, 'k') ? Number(flag(a, 'k')) : undefined });
      return out(`${res.answer}${res.sources.length ? `\n\nSources: ${res.sources.join(', ')}` : ''}${res.pages.length ? `\nPages: ${res.pages.join(', ')}` : ''}`);
    }
    case 'lint': {
      const report = await wiki.lint({ delta: !!a.flags.delta, noLlm: !!a.flags['no-llm'] });
      if (a.flags.json) {
        out(report, true);
        if (report.issues.length) process.exitCode = 1;
        return;
      }
      if (!report.issues.length) {
        return out(`No issues. Checked ${report.checkedPages}/${report.totalPages} page(s)${report.delta ? ' (delta)' : ''}; contradiction check ${report.llmUsed ? 'ran' : 'skipped'}.`);
      }
      const byType = new Map<string, string[]>();
      for (const i of report.issues) {
        const list = byType.get(i.type) ?? [];
        list.push(`${i.page ? `[${i.page}] ` : ''}${i.detail}`);
        byType.set(i.type, list);
      }
      const sections = [...byType.entries()].map(([type, items]) => `${type} (${items.length}):\n  - ${items.join('\n  - ')}`);
      out(`${report.issues.length} issue(s) across ${report.checkedPages}/${report.totalPages} page(s)${report.delta ? ' (delta)' : ''}:\n\n${sections.join('\n\n')}`);
      process.exitCode = 1;
      return;
    }
    default:
      throw new Error('usage: mercury wiki init|status|ingest <path|->|query "<q>"|lint [--delta] [--no-llm]');
  }
}

/**
 * `mercury addin [list|scaffold <name>]` — inspect discovered add-ins or write a
 * ready-to-copy starter add-in into the DATA DIR (never the product source).
 */
export async function addinCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', name] = a._;
  const json = Boolean(a.flags.json);
  if (sub === 'scaffold') {
    const n = need(name, 'mercury addin scaffold <name>');
    const r = scaffoldAddin(n, join(m.config.dataDir, 'addins'));
    return out(
      json
        ? r
        : `Created add-in "${n}" at ${r.path}\n  ${r.files.join('\n  ')}\n\nEnabled on next start. Inspect with: mercury addin list`,
      json,
    );
  }
  if (sub === 'list') {
    const rows = m.addins.addins.map((x) => ({
      name: x.name,
      enabled: x.enabled,
      version: x.version,
      personalities: x.personalities.length,
      tools: x.toolDirs.length,
      permissions: Object.keys(x.permissions).length,
      description: x.description,
    }));
    if (json) return out(rows, true);
    if (!rows.length) return out('No add-ins found. Create one with: mercury addin scaffold <name>');
    const lines = rows.map(
      (r) => `${r.enabled ? '●' : '○'} ${r.name}@${r.version} — ${r.personalities} personality(ies), ${r.tools} tool(s), ${r.permissions} profile(s)${r.description ? `  (${r.description})` : ''}`,
    );
    if (m.addins.warnings.length) lines.push('', 'Warnings:', ...m.addins.warnings.map((w) => `  ! ${w}`));
    return out(lines.join('\n'));
  }
  throw new Error('usage: mercury addin [list|scaffold <name>]');
}

/**
 * `mercury perms [list|show <personality>]` — inspect configured per-agent/personality
 * permission profiles. These only FURTHER RESTRICT the acting user (intersection); the
 * effective policy at runtime also depends on the user's own base policy.
 */
export async function permsCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'list', nameArg] = a._;
  const json = Boolean(a.flags.json);
  const profiles = m.permissionProfiles;
  if (sub === 'list') {
    const names = Object.keys(profiles).sort();
    if (json) return out(names, true);
    if (!names.length) return out('No permission profiles configured (<dataDir>/permissions/ or add-in manifests).');
    return out(`Permission profiles:\n${names.map((n) => `  - ${n}`).join('\n')}`);
  }
  if (sub === 'show') {
    const name = need(nameArg, 'mercury perms show <personality>');
    const profile = profiles[name];
    if (!profile) throw new Error(`no permission profile named "${name}"`);
    if (json) return out({ name, profile }, true);
    return out(
      `Permission profile "${name}":\n${JSON.stringify(profile, null, 2)}\n\n` +
        `Note: this profile only further RESTRICTS the acting user — the effective policy is the\n` +
        `intersection of this profile and the user's own base policy (see docs/PERMISSIONS.md).`,
    );
  }
  throw new Error('usage: mercury perms [list|show <personality>]');
}



/**
 * Learning subsystem: inspect what the agent has learned from its own runs.
 *   mercury learn stats [bucket]         observed routing success rates per (bucket, model)
 *   mercury learn hints <task...>        the experience hint that would be injected for a task
 *   mercury learn playbooks              stored failure playbooks (signature → remediation)
 */
export async function learnCmd(m: Mercury, a: Args): Promise<void> {
  const [, sub = 'stats', ...rest] = a._;
  const json = !!flag(a, 'json');
  if (!m.config.learning.enabled) {
    out('Learning is disabled. Enable it with `learning.enabled: true` in your config to record and use run outcomes.');
    return;
  }
  if (sub === 'stats') {
    const stats = m.learning.routeStats(rest[0]);
    if (json) return out(stats, true);
    if (!stats.length) return out('No routing stats recorded yet.');
    return out(stats.map((s) => `${s.bucket.padEnd(8)} ${s.model.padEnd(24)} ${s.successes}/${s.runs} (${(s.successRate * 100).toFixed(0)}%)  avg$${s.avgCost.toFixed(4)}`).join('\n'));
  }
  if (sub === 'hints') {
    const task = rest.join(' ');
    if (!task) throw new Error('usage: mercury learn hints <task...>');
    const hint = m.learning.hintFor(task, (await m.localPrincipal()).userId);
    if (json) return out(hint ?? null, true);
    return out(hint ? hint.text : 'No similar past run — no hint would be injected (graceful empty case).');
  }
  if (sub === 'playbooks') {
    const pbs = m.learning.playbooks(Number(flag(a, 'limit')) || 100);
    if (json) return out(pbs, true);
    if (!pbs.length) return out('No failure playbooks recorded yet.');
    return out(pbs.map((p) => `[${p.occurrences}x] ${p.signature}\n    → ${p.remediation ?? '(no remediation yet)'}`).join('\n'));
  }
  throw new Error('usage: mercury learn <stats [bucket] | hints <task...> | playbooks> [--json]');
}

/**
 * MCP management incl. curated connector presets and the 14 optional integrations.
 *   mercury mcp status                                   connected + configured servers (default)
 *   mercury mcp presets [--json]                         list all presets with provenance/env/state
 *   mercury mcp enable <preset> [--name n] [--connect]   write a preset into mcp.servers (enabled=true)
 *   mercury mcp disable <serverName>                      set enabled=false + disconnect (config kept)
 *
 * Every preset is DISABLED by default: `enable` is the only thing that writes `enabled: true`, and
 * `connectAll` skips any server whose `enabled` is false. Secrets are NEVER entered here — they live
 * in ~/.mercury/.env; the preset only records which env vars it needs.
 */
export async function mcpCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1] ?? 'status';
  const configured = m.config.mcp.servers;
  if (sub === 'presets') {
    if (flag(a, 'json')) {
      return out(mcpPresets().map((p) => ({
        name: p.name, description: p.description, provenance: p.provenance, pkg: p.pkg, requiredEnv: p.requiredEnv, notes: p.notes,
        configured: !!configured[p.name], enabled: configured[p.name]?.enabled ?? false,
      })), true);
    }
    return out(mcpPresets().map((p) => {
      const st = configured[p.name];
      const state = st ? (st.enabled ? 'ENABLED' : 'disabled') : '—';
      return `${p.name.padEnd(16)} [${p.provenance.padEnd(17)}] ${state.padEnd(8)} ${p.description}\n    pkg: ${p.pkg}\n    env: ${p.requiredEnv.join(', ') || '(none)'} — ${p.notes}`;
    }).join('\n'));
  }
  if (sub === 'enable') {
    const presetName = need(a._[2], 'mercury mcp enable <preset> [--name <serverName>] [--connect]');
    const serverName = flag(a, 'name') || presetName;
    const preset = mcpPreset(presetName);
    let config: import('@mercury/core').McpServerConfig;
    let missingEnv: string[] = [];
    if (preset) {
      const resolved = enablePresetConfig(preset);
      config = resolved.config;
      missingEnv = resolved.missingEnv;
    } else if (configured[presetName]) {
      // Re-enable an existing (user-defined, non-preset) server that was previously disabled.
      config = { ...configured[presetName], enabled: true };
    } else {
      throw new Error(`Unknown preset "${presetName}". Available: ${mcpPresets().map((p) => p.name).join(', ')}`);
    }
    setConfigValue(`mcp.servers.${serverName}`, config, m.configFile);
    const lines = [`Enabled MCP server "${serverName}"${preset ? ` from preset "${preset.name}"` : ''} (saved to config, enabled=true).`];
    if (missingEnv.length) lines.push(`⚠ Set these env vars in ~/.mercury/.env before use (placeholders left in config): ${missingEnv.join(', ')}`);
    if (flag(a, 'connect') && !missingEnv.length) {
      const status = await m.mcp.connect(serverName, config);
      lines.push(status.connected ? `Connected: ${status.tools.length} tool(s)` : `Connection failed: ${status.error ?? 'unknown error'}`);
    }
    return out(lines.join('\n'));
  }
  if (sub === 'disable') {
    const serverName = need(a._[2], 'mercury mcp disable <serverName>');
    if (!configured[serverName]) throw new Error(`No MCP server "${serverName}" in config. Configured: ${Object.keys(configured).join(', ') || '(none)'}`);
    setConfigValue(`mcp.servers.${serverName}.enabled`, false, m.configFile);
    await m.mcp.disconnect(serverName).catch(() => undefined);
    return out(`Disabled MCP server "${serverName}" (enabled=false, disconnected). Its config is retained — re-enable with: mercury mcp enable ${serverName}`);
  }
  if (sub === 'status') {
    return out({
      connected: m.mcp.status(),
      configured: Object.fromEntries(Object.entries(configured).map(([n, c]) => [n, { enabled: c.enabled, transport: c.transport }])),
    }, true);
  }
  return out(m.mcp.status(), true);
}

/**
 * Sharable agent bundles ("Mercury packs"): export a signed subset of this instance's config and
 * install it into another instance.
 *   mercury bundle list                                      installed bundles (ledger)
 *   mercury bundle export <name> [--version v] [--sections a,b,c] [--out file] [--desc ...]
 *   mercury bundle inspect <file>                            verify signature + compatibility
 *   mercury bundle install <file>                            verify → install (governed)
 */
export async function bundleCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1] ?? 'list';
  const json = !!flag(a, 'json');
  if (!m.config.bundles.enabled) {
    out('Bundles are disabled. Enable them with `bundles.enabled: true` in your config.');
    return;
  }

  if (sub === 'list') {
    const installed = m.bundles.list();
    if (json) return out(installed, true);
    if (!installed.length) return out('No bundles installed yet.');
    return out(
      installed
        .map(
          (b) =>
            `${b.name.padEnd(24)} v${String(b.version).padEnd(10)} applied=[${b.applied.join(',')}] pending=[${b.pending.join(',')}] ${b.status}  ${b.createdAt}`,
        )
        .join('\n'),
    );
  }

  if (sub === 'export') {
    const name = need(a._[2], 'mercury bundle export <name> [--version v] [--sections a,b,c] [--out file] [--desc ...]');
    const sections = flag(a, 'sections')
      ? (flag(a, 'sections')!.split(',').map((s) => s.trim()).filter(Boolean) as never)
      : undefined;
    const { bundle, path } = m.bundles.exportToFile({
      name,
      version: flag(a, 'version'),
      sections,
      description: flag(a, 'desc'),
      author: flag(a, 'author'),
    });
    const outPath = flag(a, 'out');
    if (outPath) writeFileSync(outPath, JSON.stringify(bundle, null, 2), 'utf8');
    if (json) return out(bundle, true);
    return out(
      `Exported bundle "${bundle.manifest.name}" v${bundle.manifest.version} [${bundle.manifest.sections.join(', ') || 'empty'}]\n` +
        `  signature: ${bundle.signature.slice(0, 16)}…\n` +
        `  written to: ${outPath ?? path}`,
    );
  }

  if (sub === 'inspect') {
    const file = need(a._[2], 'mercury bundle inspect <file>');
    const res = m.bundles.inspect(m.bundles.read(file));
    if (json) return out(res, true);
    const lines = [
      `Bundle "${res.manifest.name}" v${res.manifest.version} (format v${res.manifest.formatVersion}, from Mercury v${res.manifest.mercuryVersion})`,
      `  sections:   ${res.sections.join(', ') || '(none)'}`,
      `  governed:   ${res.governed.join(', ') || '(none)'} (install routes these through approval)`,
      `  signature:  ${res.signatureValid ? 'VALID' : 'INVALID / tampered'}`,
      `  compatible: ${res.compatible ? 'yes' : 'no'}`,
      `  digest:     ${res.digest.slice(0, 16)}…`,
    ];
    if (res.issues.length) lines.push(`  issues:     ${res.issues.join('; ')}`);
    return out(lines.join('\n'));
  }

  if (sub === 'install') {
    const file = need(a._[2], 'mercury bundle install <file>');
    const res = m.bundles.install(m.bundles.read(file), { source: file });
    if (json) return out(res, true);
    const head = res.status === 'installed' ? '✓ Installed' : res.status === 'unchanged' ? '• Unchanged' : '✗ Rejected';
    const lines = [`${head} bundle "${res.name}" v${res.version}`, `  applied: ${res.applied.join(', ') || '(none)'}`];
    if (res.pending.length) lines.push(`  pending approval (governed): ${res.pending.join(', ')} — approve in the web UI or via the API`);
    if (res.issues.length) lines.push(`  notes: ${res.issues.join('; ')}`);
    return out(lines.join('\n'));
  }

  throw new Error(
    'usage: mercury bundle <list | export <name> [--version v] [--sections a,b,c] [--out file] | inspect <file> | install <file>> [--json]',
  );
}

export async function memoryCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1] ?? 'recall';
  const json = !!flag(a, 'json');
  const p = m.principalFor(flag(a, 'user'));
  const ns = flag(a, 'ns');
  switch (sub) {
    case 'remember': {
      const text = need(a._[2], 'mercury memory remember <text> [--ns name] [--tags a,b]');
      const r = await m.memory.remember(p.userId, text, { namespace: ns, tags: flag(a, 'tags')?.split(',').map((s) => s.trim()).filter(Boolean), source: 'cli', principal: p });
      return out(json ? r : `remembered ${r.id} (ns=${r.namespace})`, json);
    }
    case 'recall': {
      const q = need(a._[2], 'mercury memory recall <query> [--ns name] [--k N]');
      const facts = await m.memory.recall(p.userId, q, flag(a, 'k') ? Number(flag(a, 'k')) : 5, undefined, { namespace: ns, principal: p });
      return out(json ? facts : facts.map((f) => `${f.id}  ${f.content}`).join('\n') || '(no matches)', json);
    }
    case 'forget': {
      const id = need(a._[2], 'mercury memory forget <id|text> [--ns name]');
      return out({ removed: await m.memory.forget(p.userId, id, { namespace: ns, principal: p }) }, json);
    }
    case 'ns':
      return out(json ? m.memory.namespaces(p.userId) : m.memory.namespaces(p.userId).map((n) => `${n.namespace.padEnd(24)} ${n.count}`).join('\n') || '(none)', json);
    case 'knowledge': {
      const op = a._[2];
      if (op === 'add') {
        const content = need(a._[3], 'mercury memory knowledge add <content> [--title t] [--uri u] [--ns name]');
        const r = await m.memory.addKnowledge(p.userId, { title: flag(a, 'title'), uri: flag(a, 'uri'), content }, { namespace: ns, principal: p });
        return out(json ? r : `ingested source ${r.sourceId} (${r.chunks} chunks)`, json);
      }
      if (op === 'search') {
        const q = need(a._[3], 'mercury memory knowledge search <query> [--k N] [--ns name]');
        const chunks = await m.memory.searchKnowledge(p.userId, q, flag(a, 'k') ? Number(flag(a, 'k')) : undefined, { namespace: ns });
        return out(json ? chunks : chunks.map((c) => `[${c.title || c.sourceId}#${c.chunkIndex}] ${c.content.slice(0, 160)}`).join('\n\n') || '(no matches)', json);
      }
      throw new Error('usage: mercury memory knowledge <add <content> | search <query>> [--ns name] [--json]');
    }
    case 'audit': {
      const res = m.memory.auditLog({ userId: p.userId, namespace: ns, action: flag(a, 'action') as never, decision: flag(a, 'decision') as never, limit: flag(a, 'limit') ? Number(flag(a, 'limit')) : 50 });
      return out(json ? res : res.entries.map((e) => `${e.createdAt}  ${e.action.padEnd(10)} ${e.decision.padEnd(7)} ns=${e.namespace} ${e.reason}`).join('\n') || '(no audit entries)', json);
    }
    default:
      throw new Error('usage: mercury memory <remember <text> | recall <query> | forget <id> | ns | knowledge add|search | audit> [--ns name] [--json]');
  }
}

export async function teamCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1] ?? 'list';
  const json = !!flag(a, 'json');
  if (!m.config.teams.enabled) {
    out('Teams are disabled. Enable them with `teams.enabled: true` in your config.');
    return;
  }
  const p = m.principalFor(flag(a, 'user'));
  switch (sub) {
    case 'list': {
      const teams = m.teams.list();
      return out(json ? teams : teams.map((t) => `${t.name.padEnd(24)} ${t.strategy.padEnd(12)} members=${t.members.length}`).join('\n') || '(no teams)', json);
    }
    case 'create': {
      const name = need(a._[2], 'mercury team create <name> --members "role1:goal1;role2:goal2" [--strategy coordinator|pipeline|debate]');
      const members = (flag(a, 'members') ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((spec) => {
        const [role, task] = spec.split(':');
        return { name: (role ?? 'member').trim(), role: (role ?? 'member').trim(), task: (task ?? '').trim() || undefined };
      });
      if (!members.length) throw new Error('provide --members "role1:goal1;role2:goal2"');
      const def = m.teams.define(p, { name, description: flag(a, 'desc'), strategy: flag(a, 'strategy') as never, members });
      return out(json ? def : `created team "${def.name}" (${def.strategy}, ${def.members.length} members)`, json);
    }
    case 'show': {
      const t = m.teams.get(need(a._[2], 'mercury team show <name|id>'));
      if (!t) throw new Error('unknown team');
      return out(t, true);
    }
    case 'delete':
      return out({ removed: m.teams.delete(p, need(a._[2], 'mercury team delete <name|id>')) }, json);
    case 'run': {
      const id = need(a._[2], 'mercury team run <name|id> <task> [--budget N] [--approve]');
      const task = need(a._[3], 'mercury team run <name|id> <task>');
      const rec = await m.teams.run(p, id, task, { approve: !!a.flags.approve, budget: flag(a, 'budget') ? Number(flag(a, 'budget')) : undefined });
      if (json) return out(rec, true);
      return out([`team "${rec.teamName}" run ${rec.id}: ${rec.status} (cost=${rec.cost})`, ...rec.trace.map((s) => `  ${s.member.padEnd(20)} ${s.status.padEnd(9)} ${String(s.output).slice(0, 120)}`), '', rec.output].join('\n'));
    }
    case 'runs': {
      const runs = m.teams.listRuns(flag(a, 'team'));
      return out(json ? runs : runs.map((r) => `${r.id}  ${r.teamName.padEnd(20)} ${r.status.padEnd(9)} ${r.startedAt}`).join('\n') || '(no runs)', json);
    }
    default:
      throw new Error('usage: mercury team <list | create <name> --members ... | show <id> | delete <id> | run <id> <task> | runs> [--json]');
  }
}


const SECURITY_HELP = `usage: mercury security audit [--npm] [--mcp] [--plugins] [--lockfile <path>] [--json]

Supply-chain vulnerability audit via the free OSV.dev API (no API key required). Enumerates
package coordinates and queries OSV for known vulnerabilities.

Sources (default: all; pass one or more flags to narrow):
  --npm              npm packages from package-lock.json
  --mcp              npm packages invoked by configured MCP servers (npx-launched)
  --plugins          installed plugins and the npm dependencies they declare
Options:
  --lockfile <path>  override the npm lockfile (default: ./package-lock.json)
  --json             emit the full machine-readable report

Exit code: 0 clean · 1 vulnerabilities found · 2 audit could not complete (network/parse error).
The audit makes live calls to https://api.osv.dev when run; results depend on OSV availability.`;

/** Read a plugin's package.json from the directory of its entry file (or one level up for dist/ layouts). */
function readPluginPkgJson(entryPath: string): PackageJsonLike | undefined {
  for (const cand of [join(dirname(entryPath), 'package.json'), join(dirname(dirname(entryPath)), 'package.json')]) {
    if (!existsSync(cand)) continue;
    try {
      return JSON.parse(readFileSync(cand, 'utf8')) as PackageJsonLike;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return undefined;
}

/**
 * `mercury security audit` — supply-chain CVE audit over OSV.dev across npm dependencies, configured
 * MCP servers and installed plugins. Human-readable table by default, `--json` for the full report.
 * Sets a CI-friendly exit code (0 clean / 1 vulnerable / 2 could-not-complete).
 */
export async function securityCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1];
  if (sub !== 'audit' || a.flags.help) return out(SECURITY_HELP);

  const want = { npm: !!a.flags.npm, mcp: !!a.flags.mcp, plugins: !!a.flags.plugins };
  const all = !want.npm && !want.mcp && !want.plugins;
  const coords: Coordinate[] = [];
  const notes: string[] = [];

  // 1) npm dependencies from the lockfile.
  if (all || want.npm) {
    const lockPath = flag(a, 'lockfile') ?? join(process.cwd(), 'package-lock.json');
    if (existsSync(lockPath)) {
      try {
        coords.push(...extractNpmCoordinates(readFileSync(lockPath, 'utf8')));
      } catch (err) {
        notes.push(`npm: ${(err as Error).message}`);
      }
    } else {
      notes.push(`npm: no lockfile at ${lockPath} (use --lockfile <path>)`);
    }
  }

  // Installed npm versions (from the lockfile) let us pin MCP/plugin packages that are also present.
  const installed = new Map<string, string>();
  for (const c of coords) if (c.source === 'npm') installed.set(c.name, c.version);

  // 2) Configured MCP servers (every configured server, enabled or not).
  if (all || want.mcp) coords.push(...mcpServerCoordinates(m.config.mcp.servers, installed, true));

  // 3) Installed plugins + the npm deps they declare.
  if (all || want.plugins) {
    const plugs: PluginPkg[] = m.plugins.map((p) => ({ name: p.name, pkgJson: readPluginPkgJson(p.path) }));
    coords.push(...pluginCoordinates(plugs));
  }

  const report = await auditCoordinates(coords, { http: fetchHttpClient });
  report.errors.unshift(...notes);

  if (a.flags.json) {
    out(report, true);
    process.exitCode = exitCodeFor(report.status);
    return;
  }

  const lines: string[] = [];
  lines.push(`Mercury supply-chain audit (OSV.dev) — sources: ${report.sources.join(', ') || '(none)'}`);
  lines.push(`Scanned ${report.scanned} package(s); ${report.vulnerablePackages} vulnerable, ${report.findings.length} finding(s).`);
  for (const bySource of ['npm', 'mcp', 'plugin'] as const) {
    const group = report.findings.filter((f) => f.coordinate.source === bySource);
    if (!group.length) continue;
    lines.push(`\n[${bySource}]`);
    for (const f of group) {
      const ver = f.coordinate.version || '(unpinned)';
      const via = f.coordinate.via ? ` via ${f.coordinate.via}` : '';
      const ids = [f.id, ...f.aliases].join(', ');
      const sev = f.severity ? `  severity=${f.severity}` : '';
      const fix = f.fixedVersion ? `  fixed-in=${f.fixedVersion}` : '';
      lines.push(`  ${f.coordinate.name}@${ver}${via}`);
      lines.push(`    ${ids}${sev}${fix}`);
      if (f.summary) lines.push(`    ${f.summary}`);
    }
  }
  if (report.errors.length) {
    lines.push(`\nWarnings/errors:`);
    for (const e of report.errors) lines.push(`  ! ${e}`);
  }
  lines.push(`\nResult: ${report.status.toUpperCase()}${report.status === 'clean' ? ' — no known vulnerabilities found.' : ''}`);
  out(lines.join('\n'));
  process.exitCode = exitCodeFor(report.status);
}
