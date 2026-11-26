/** Administrative subcommands (users, tokens, tools, skills, schedules, config, doctor, import...). */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACP_PROTOCOL_VERSION, LSP_PROTOCOL, LSP_COMMANDS, auditCoordinates, errorMessage, buildArchive, buildSessionExport, checkArchiveCompat, collectDataDir, exitCodeFor, extractNpmCoordinates, fetchHttpClient, filterSessions, findSession, activeProjectName, createProject, getPath, buildInsights, resolveInsightsRange, formatTokens, formatCost, type InsightsGroupBy, type InsightsReport, buildMemGraphFromDb, memGraphToDot, buildJourney, resolveJourneyRange, type MemGraph, type JourneyTimeline, type JourneyEventKind, generateCompletion, COMPLETION_SHELLS, type CompletionShell, queryOperatorLogs, formatOperatorLogs, resolveOperatorLogRange, computePromptSize, formatPromptSize, readMigrationStatus, applyPendingMigrations, operatorBanner, INSTRUCTION_HIERARCHY, parseHookDefs, validateHookDef, buildHookPlan, runHookPlan, defaultHookRunner, formatHookList, formatHookResult, HOOKS_EVENTS, type HookConfigEntry, type HooksEventName, installPlugin, installSkills, listInstalled, listProjects, loadOrCreateAuditKey, mcpServerCoordinates, mercuryHome, planRestore, runMoa, type MoaStrategy, type MoaResult, pluginCoordinates, projectDataDirEntryCount, readArchiveFile, removePlugin, removeProject, renderSessionMarkdown, resolveVoicePreset, restoreArchive, runEvalSuite, scaffold, scaffoldAddin, selectEvals, selectPrune, setConfigValue, showProject, updatePlugin, useProject, verifyArchive, verifyArchiveIntegrity, voicePresets, workingDirOf, writeArchiveFile, secretResolverFromConfig, scanSecretRefs, unwrapSecretRef, maskSecret, defaultSecretRunner, activeProfileName, createProfile, listProfiles, profileHomeEntryCount, profileRegistryDir, removeProfile, showProfile, useProfile, DEFAULT_PROFILE_NAME, PROFILE_ENV_VAR, type BackupArchive, type Coordinate, type EvalObservation, type ExtensionKind, type PackageJsonLike, type PluginPkg, type ProfileListEntry, type ProjectListEntry, type SecretResolver, type Session, type VoiceKind } from '@mercury/core';
import type { Mercury } from '@mercury/runtime';
import { enablePresetConfig, mcpPreset, mcpPresets } from '@mercury/mcp';
import { flag, type Args } from './args.js';
import { repl } from './repl.js';

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

const PLUGINS_HELP = `usage: mercury plugins [list|install|update|remove]

  list                         List loaded plugins (default; bare 'plugins')
  install <path|git-url>       Install a plugin from a local path or git URL into ~/.mercury/plugins
      [--name <name>]          Override the derived install name
      [--force]                Overwrite an existing install of the same name
      [--build]                Run 'npm install && npm run build' if the plugin declares a build script
  update <name>                Update a plugin from its recorded source (git pull or re-copy)
      [--all]                  Update every managed plugin instead of one
  remove <name> --force        Remove an installed plugin directory (requires --force or --yes)

  --json                       Machine-readable output (install/update/remove/list)`;

export async function pluginsCmd(m: Mercury, a: Args): Promise<void> {
  const json = flag(a, 'json') !== undefined || a.flags.json === true;
  const pluginsDir = join(m.config.dataDir, 'plugins');
  const sub = a._[1];

  switch (sub) {
    case undefined:
    case 'list': {
      if (json) {
        out(listInstalled(pluginsDir), true);
        return;
      }
      out(
        m.plugins.length
          ? m.plugins.map((p) => `${p.name} ${p.version ?? ''} ${p.error ? `ERROR: ${p.error}` : ''}`.trim()).join('\n')
          : `(no plugins; put them in ${pluginsDir}${existsSync(pluginsDir) ? `, found: ${readdirSync(pluginsDir).join(', ')}` : ''})`,
      );
      return;
    }

    case 'install': {
      const source = need(a._[2], 'mercury plugins install <path|git-url> [--name n] [--force] [--build]');
      const res = installPlugin(pluginsDir, source, {
        name: flag(a, 'name'),
        force: a.flags.force === true,
        build: a.flags.build === true,
      });
      if (json) out(res, true);
      else
        out(
          `Installed plugin "${res.name}" (${res.source.type}) at ${res.dir}` +
            `${res.version ? ` v${res.version}` : ''}${res.reinstalled ? ' (reinstalled)' : ''}${res.built ? ' [built]' : ''}.\n` +
            `Restart Mercury (or the server) to load it.`,
        );
      return;
    }

    case 'update': {
      if (a.flags.all === true) {
        const installed = listInstalled(pluginsDir).filter((p) => p.managed);
        const results = [] as Array<{ name: string; ok: boolean; method?: string; error?: string }>;
        for (const p of installed) {
          try {
            const r = updatePlugin(pluginsDir, p.name);
            results.push({ name: r.name, ok: true, method: r.method });
          } catch (err) {
            process.exitCode = 1;
            results.push({ name: p.name, ok: false, error: (err as Error).message });
          }
        }
        if (json) out(results, true);
        else if (results.length === 0) out('(no managed plugins to update)');
        else out(results.map((r) => (r.ok ? `Updated "${r.name}" (${r.method})` : `FAILED "${r.name}": ${r.error}`)).join('\n'));
        return;
      }
      const name = need(a._[2], 'mercury plugins update <name>|--all');
      const res = updatePlugin(pluginsDir, name);
      if (json) out(res, true);
      else out(`Updated plugin "${res.name}" (${res.method})${res.version ? ` v${res.version}` : ''}. Restart Mercury to reload it.`);
      return;
    }

    case 'remove': {
      const name = need(a._[2], 'mercury plugins remove <name> --force');
      if (a.flags.force !== true && a.flags.yes !== true) {
        throw new Error(`refusing to remove plugin "${name}" without --force (or --yes)`);
      }
      const res = removePlugin(pluginsDir, name);
      if (json) out(res, true);
      else out(`Removed plugin "${res.name}" (${res.dir}). Restart Mercury to unload it.`);
      return;
    }

    default:
      out(PLUGINS_HELP);
      process.exitCode = 1;
  }
}

export function copyAssets(from: string, to: string): void {
  cpSync(from, to, { recursive: true, errorOnExist: false });
}

export const INSIGHTS_HELP = `mercury insights — usage analytics over the recorded token/cost ledger

Aggregates the usage ledger Mercury already records (the 'usage' table written on every model
call, joined to 'runs' for session attribution). Read-only; adds no instrumentation.

Usage:
  mercury insights [--by day|model|agent|session] [--since <dur|ISO>] [--until <dur|ISO>]
                   [--top <n>] [--limit <n>] [--json]

Flags:
  --by <dim>       Breakdown dimension: day (default), model, agent (user), or session
  --since <d>      Only usage at/after this time — a duration (30d, 12h, 90m, 2w) or ISO date
  --until <d>      Only usage before this time — duration or ISO date
  --top <n>        Keep only the N costliest buckets (model/agent/session groupings)
  --limit <n>      Read at most N ledger rows (most-recent first) before aggregating
  --json           Emit the full report as JSON

An empty ledger prints "no usage recorded" and exits 0.`;

/** Render an insights report as a human table (totals + grouped breakdown). */
function renderInsights(r: InsightsReport): string {
  const t = r.totals;
  const lines: string[] = [];
  const range = r.firstTs && r.lastTs ? `${r.firstTs.slice(0, 10)} → ${r.lastTs.slice(0, 10)}` : '(all time)';
  lines.push(`Usage insights  ${range}`);
  lines.push(
    `  totals: ${t.calls.toLocaleString('en-US')} calls, ${formatTokens(t.tokens)} tokens ` +
      `(${formatTokens(t.inputTokens)} in / ${formatTokens(t.outputTokens)} out), ${formatCost(t.cost)}`,
  );
  lines.push('');
  const label = r.by === 'agent' ? 'AGENT' : r.by.toUpperCase();
  lines.push(`${label.padEnd(24)} ${'CALLS'.padStart(8)} ${'TOKENS'.padStart(10)} ${'COST'.padStart(10)}`);
  for (const b of r.buckets) {
    lines.push(
      `${b.key.slice(0, 24).padEnd(24)} ${b.calls.toLocaleString('en-US').padStart(8)} ` +
        `${formatTokens(b.tokens).padStart(10)} ${formatCost(b.cost).padStart(10)}`,
    );
  }
  return lines.join('\n');
}

/**
 * `mercury insights` — aggregate the recorded usage ledger into a reportable analytics view. Pure
 * aggregation lives in @mercury/core; this only parses flags, fetches rows read-only and renders.
 */
export function insightsCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(INSIGHTS_HELP);
  const json = !!a.flags.json;
  const byRaw = (flag(a, 'by') ?? 'day').toLowerCase();
  const valid: InsightsGroupBy[] = ['day', 'model', 'agent', 'session'];
  if (!valid.includes(byRaw as InsightsGroupBy)) {
    throw new Error(`invalid --by "${byRaw}" (use: ${valid.join(', ')})`);
  }
  const by = byRaw as InsightsGroupBy;
  const top = flag(a, 'top') !== undefined ? Math.max(0, Number(flag(a, 'top'))) : undefined;
  const limit = flag(a, 'limit') !== undefined ? Math.max(0, Number(flag(a, 'limit'))) : undefined;
  if (top !== undefined && Number.isNaN(top)) throw new Error('invalid --top (expected a number)');
  if (limit !== undefined && Number.isNaN(limit)) throw new Error('invalid --limit (expected a number)');
  const { sinceIso, untilIso } = resolveInsightsRange({ since: flag(a, 'since'), until: flag(a, 'until') });

  const report = buildInsights(m.db, { range: { sinceIso, untilIso, limit }, by, top });
  if (json) return out(report, true);
  if (report.empty) return out('no usage recorded');
  return out(renderInsights(report));
}

export const MEMORY_GRAPH_HELP = `mercury memory-graph — a graph view over the memory Mercury already records

Builds a graph of memory entities (facts, distilled skills, runs, sessions, knowledge sources) and the
REAL relationships stored between them. Read-only; adds no instrumentation. Edges are grounded in
stored columns — none are invented:
  skill  --distilled_from--> run        (distilled_skills.source_runs)
  run    --in_session------> session    (runs.session_id)
  run    --spawned---------> run         (runs.parent_run_id — parent → child)
  fact   --sourced_from----> run|session (facts.source, only when it equals a known id)

Usage:
  mercury memory-graph [--since <dur|ISO>] [--until <dur|ISO>] [--limit <n>] [--top <n>] [--dot] [--json]

Flags:
  --since <d>   Only entities created at/after this time — a duration (30d, 12h, 2w) or ISO date
  --until <d>   Only entities created before this time — duration or ISO date
  --limit <n>   Read at most N rows per source table (most-recent first)
  --top <n>     How many most-connected nodes to list in the summary (default 10)
  --dot         Emit Graphviz DOT (pipe to \`dot -Tsvg\` to render)
  --json        Emit the full graph ({ nodes, edges, summary }) as JSON

An empty memory prints "memory graph is empty" and exits 0.`;

/** Render a memory graph as a readable summary (counts + top connected nodes). */
function renderMemGraph(g: MemGraph): string {
  const s = g.summary;
  const lines: string[] = [];
  lines.push(`Memory graph  ${s.nodeCount} nodes, ${s.edgeCount} edges`);
  lines.push(
    `  nodes: ${Object.entries(s.nodesByKind).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || '(none)'}`,
  );
  lines.push(
    `  edges: ${Object.entries(s.edgesByRel).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`).join(', ') || '(none)'}`,
  );
  if (s.topConnected.length) {
    lines.push('');
    lines.push('Most connected:');
    for (const d of s.topConnected) lines.push(`  ${String(d.degree).padStart(3)}  [${d.kind}] ${d.label}`);
  }
  return lines.join('\n');
}

/**
 * `mercury memory-graph` — project the stored memory layers into a graph. Pure graph construction +
 * DOT export live in @mercury/core; this only parses flags, fetches rows read-only and renders.
 */
export function memoryGraphCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(MEMORY_GRAPH_HELP);
  const top = flag(a, 'top') !== undefined ? Math.max(0, Number(flag(a, 'top'))) : undefined;
  const limit = flag(a, 'limit') !== undefined ? Math.max(0, Number(flag(a, 'limit'))) : undefined;
  if (top !== undefined && Number.isNaN(top)) throw new Error('invalid --top (expected a number)');
  if (limit !== undefined && Number.isNaN(limit)) throw new Error('invalid --limit (expected a number)');
  const { sinceIso, untilIso } = resolveJourneyRange({ since: flag(a, 'since'), until: flag(a, 'until') });
  const graph = buildMemGraphFromDb(m.db, { range: { sinceIso, untilIso, limit }, top });
  if (a.flags.dot) return out(memGraphToDot(graph));
  if (a.flags.json) return out(graph, true);
  if (graph.summary.empty) return out('memory graph is empty');
  return out(renderMemGraph(graph));
}

export const JOURNEY_HELP = `mercury journey — a chronological timeline of the agent's significant events

A newest-first timeline built from events Mercury already records: memory formation (facts), skill
distillation, knowledge ingestion, runs, learn/reflection outcomes, and session starts. Read-only;
adds no instrumentation.

Usage:
  mercury journey [--since <dur|ISO>] [--until <dur|ISO>] [--limit <n>] [--kind <k1,k2>] [--json]

Flags:
  --since <d>   Only events at/after this time — a duration (30d, 12h, 2w) or ISO date
  --until <d>   Only events before this time — duration or ISO date
  --limit <n>   Show at most N (most-recent) events
  --kind <k>    Comma-separated event kinds: memory, skill, knowledge, run, learn, session
  --json        Emit the full timeline ({ events, counts, total, ... }) as JSON

An empty history prints "no journey events recorded" and exits 0.`;

const JOURNEY_GLYPH: Record<JourneyEventKind, string> = {
  memory: 'M',
  skill: 'S',
  knowledge: 'K',
  run: 'R',
  learn: 'L',
  session: '·',
};

/** Render a journey timeline as a readable, newest-first list. */
function renderJourney(t: JourneyTimeline): string {
  const lines: string[] = [];
  const range = t.firstTs && t.lastTs ? `${t.firstTs.slice(0, 10)} → ${t.lastTs.slice(0, 10)}` : '(all time)';
  const shown = t.events.length < t.total ? `${t.events.length} of ${t.total}` : `${t.total}`;
  lines.push(`Journey  ${range}  (${shown} events)`);
  lines.push(
    `  ${Object.entries(t.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || '(none)'}`,
  );
  lines.push('');
  for (const e of t.events) {
    lines.push(`${e.ts.slice(0, 19).replace('T', ' ')}  [${JOURNEY_GLYPH[e.kind]}] ${e.title}`);
  }
  return lines.join('\n');
}

const VALID_JOURNEY_KINDS: JourneyEventKind[] = ['memory', 'skill', 'knowledge', 'run', 'learn', 'session'];

/**
 * `mercury journey` — a chronological timeline over the recorded memory/skill/run/learn events. Pure
 * assembly lives in @mercury/core; this only parses flags, fetches rows read-only and renders.
 */
export function journeyCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(JOURNEY_HELP);
  const limit = flag(a, 'limit') !== undefined ? Math.max(0, Number(flag(a, 'limit'))) : undefined;
  if (limit !== undefined && Number.isNaN(limit)) throw new Error('invalid --limit (expected a number)');
  let kinds: JourneyEventKind[] | undefined;
  const kindRaw = flag(a, 'kind');
  if (kindRaw) {
    kinds = kindRaw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) as JourneyEventKind[];
    const bad = kinds.filter((k) => !VALID_JOURNEY_KINDS.includes(k));
    if (bad.length) throw new Error(`invalid --kind "${bad.join(', ')}" (use: ${VALID_JOURNEY_KINDS.join(', ')})`);
  }
  const { sinceIso, untilIso } = resolveJourneyRange({ since: flag(a, 'since'), until: flag(a, 'until') });
  const timeline = buildJourney(m.db, { options: { sinceIso, untilIso, limit, kinds } });
  if (a.flags.json) return out(timeline, true);
  if (timeline.empty) return out('no journey events recorded');
  return out(renderJourney(timeline));
}

const PROJECT_HELP = `usage: mercury project list [--json]
       mercury project create <name> [--dir <path>] [--folder <p1,p2>] [--desc <text>] [--use] [--json]
       mercury project use <name> [--json]
       mercury project show [name] [--json]
       mercury project current [--json]
       mercury project remove <name> [--force|--yes] [--purge] [--json]

Named workspaces, each with its OWN data dir — scoping config AND memory so projects never share state.
Projects are tracked in a registry (${'~/.mercury'}/projects.json); the active project's data dir is used
automatically on the next run (an explicit MERCURY_DATA_DIR or MERCURY_PROJECT env var overrides it).

  list                        List all projects (name, active marker, data dir, description).
    --json                    Emit the projects as JSON.
  create <name>               Create a project and its data dir under ~/.mercury/projects/<name>.
    --dir <path>              Use <path> as the data dir instead of the default.
    --folder <p1,p2>          Extra working folder(s) to associate (comma-separated; created if missing).
    --desc <text>             A short description.
    --use                     Make the new project active immediately.
    --json                    Emit the created project as JSON.
  use <name>                  Switch the active project (applies on the next run).
  show [name]                 Show a project's details; with no name, the active project.
  current                     Print the active project's name (or "(none)").
  remove <name>               Unregister a project. Requires --force/--yes. The data dir is kept unless:
    --purge                   ...also delete the project's data dir from disk (extra-destructive).
    --force, --yes            Confirm the removal.
    --json                    Emit the result as JSON.

Switching does NOT migrate data; each project keeps its own memory DB, config, plugins and skills.`;

/** One human table row for a project. */
const projectRow = (p: ProjectListEntry): string => {
  const marker = p.isActive ? '*' : ' ';
  const name = (p.name || '').slice(0, 24).padEnd(24);
  const missing = p.dataDirExists ? '' : '  (data dir missing)';
  const desc = p.description ? `  ${p.description}` : '';
  return `${marker} ${name} ${p.dataDir}${missing}${desc}`;
};

/**
 * `mercury project <list|create|use|show|current|remove>` — named, multi-folder workspaces that scope the
 * data/memory dir per project (built on the existing data-dir indirection). Mirrors the shape/quality of
 * `sessionsCmd` / `pluginsCmd`: bare command prints help, --json everywhere, destructive remove gated
 * behind --force/--yes.
 */
export async function projectCmd(m: Mercury, a: Args): Promise<void> {
  void m; // project management operates on the Mercury HOME registry, not the (already-scoped) instance.
  const sub = a._[1];
  if (!sub || a.flags.help) return out(PROJECT_HELP);
  const json = !!a.flags.json;
  const force = !!a.flags.force || !!a.flags.yes;
  const home = mercuryHome();

  switch (sub) {
    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const rows = listProjects(home);
      if (json) return out(rows, true);
      if (!rows.length) return out('(no projects; create one with: mercury project create <name>)');
      return out(rows.map(projectRow).join('\n'));
    }

    // ── create ───────────────────────────────────────────────────────────────
    case 'create': {
      const name = need(a._[2], 'mercury project create <name> [--dir <path>] [--folder <p1,p2>] [--desc <text>] [--use]');
      const folderArg = flag(a, 'folder') ?? flag(a, 'folders');
      const folders = folderArg ? folderArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const project = createProject(home, name, {
        dataDir: flag(a, 'dir'),
        folders,
        description: flag(a, 'desc') ?? flag(a, 'description'),
        use: !!a.flags.use,
      });
      if (json) return out(project, true);
      return out(
        `Created project "${project.name}" (data dir: ${project.dataDir})` +
          `${project.folders.length ? `\n  folders: ${project.folders.join(', ')}` : ''}` +
          `${a.flags.use ? `\n  now active.` : `\n  activate it with: mercury project use ${project.name}`}`,
      );
    }

    // ── use ───────────────────────────────────────────────────────────────
    case 'use': {
      const name = need(a._[2], 'mercury project use <name>');
      const project = useProject(home, name);
      if (json) return out({ active: project.name, dataDir: project.dataDir }, true);
      return out(`Active project is now "${project.name}" (data dir: ${project.dataDir}). Applies on the next run.`);
    }

    // ── show ───────────────────────────────────────────────────────────────
    case 'show': {
      const details = showProject(home, a._[2]);
      if (!details) {
        if (json) return out({ active: null }, true);
        return out('(no active project; select one with: mercury project use <name>)');
      }
      const enriched = { ...details, dataDirEntries: projectDataDirEntryCount(details.dataDir) };
      if (json) return out(enriched, true);
      return out(
        [
          `name:        ${details.name}${details.isActive ? '  (active)' : ''}`,
          `data dir:    ${details.dataDir}${details.dataDirExists ? '' : '  (missing)'}`,
          `entries:     ${enriched.dataDirEntries}`,
          `folders:     ${details.folders.length ? details.folders.join(', ') : '(none)'}`,
          `description: ${details.description ?? '(none)'}`,
          `created:     ${details.createdAt || '(unknown)'}`,
        ].join('\n'),
      );
    }

    // ── current ───────────────────────────────────────────────────────────────
    case 'current': {
      const name = activeProjectName(home);
      if (json) return out({ active: name ?? null }, true);
      return out(name ?? '(none)');
    }

    // ── remove ───────────────────────────────────────────────────────────────
    case 'remove': {
      const name = need(a._[2], 'mercury project remove <name> [--force|--yes] [--purge]');
      if (!force) {
        process.exitCode = 1;
        throw new Error(`refusing to remove project "${name}" without --force (or --yes)`);
      }
      const result = removeProject(home, name, { purge: !!a.flags.purge });
      if (json) return out(result, true);
      return out(
        `Removed project "${result.name}".` +
          `${result.purged ? ` Deleted its data dir (${result.dataDir}).` : ` Kept its data dir (${result.dataDir}); pass --purge to delete it.`}` +
          `${result.wasActive ? ` It was the active project; no project is active now.` : ''}`,
      );
    }

    default:
      out(PROJECT_HELP);
      process.exitCode = 1;
  }
}

const PROFILE_HELP = `usage: mercury profile list [--json]
       mercury profile create <name> [--home <path>] [--desc <text>] [--use] [--json]
       mercury profile use <name> [--json]
       mercury profile show [name] [--json]
       mercury profile current [--json]
       mercury profile remove <name> [--force|--yes] [--purge] [--json]

Multiple fully ISOLATED instances. Each profile is its own MERCURY_HOME — its own config, memory DB,
skills, plugins and audit key. This is the home-level sibling of a project: a profile selects the HOME,
a project (within it) selects the data dir. The built-in "default" profile maps to ~/.mercury, so
existing setups are unaffected. Profiles are tracked in ~/.config/mercury/profiles.json.

Switching mechanism: a process cannot change its parent shell's environment, so "use" BOTH persists the
selection (new Mercury processes pick it up automatically) AND prints the exact
"export ${PROFILE_ENV_VAR}=<name>" line to apply it to your current shell right now (like pyenv/direnv).

  list                        List all profiles (name, active marker, home dir, description).
    --json                    Emit the profiles as JSON.
  create <name>               Create a profile and its home dir under ~/.mercury-profiles/<name>.
    --home <path>             Use <path> as the home dir instead of the default.
    --desc <text>             A short description.
    --use                     Make the new profile active immediately.
    --json                    Emit the created profile as JSON.
  use <name>                  Switch the active profile (persisted; prints the export line to apply now).
  show [name]                 Show a profile's details; with no name, the active (or default) profile.
  current                     Print the active profile's name ("default" when none is selected).
  remove <name>               Unregister a profile. Requires --force/--yes. The home dir is kept unless:
    --purge                   ...also delete the profile's home dir from disk (extra-destructive).
    --force, --yes            Confirm the removal.
    --json                    Emit the result as JSON.

An explicit MERCURY_HOME always wins; otherwise ${PROFILE_ENV_VAR} overrides the stored active profile.
The "default" profile cannot be created, removed, or purged.`;

/** One human table row for a profile. */
const profileRow = (p: ProfileListEntry): string => {
  const marker = p.isActive ? '*' : ' ';
  const name = (p.name || '').slice(0, 24).padEnd(24);
  const missing = p.homeExists ? '' : '  (home missing)';
  const desc = p.description ? `  ${p.description}` : '';
  return `${marker} ${name} ${p.home}${missing}${desc}`;
};

/**
 * `mercury profile <list|create|use|show|current|remove>` — multiple fully isolated instances, each with
 * its own MERCURY_HOME (the home-level sibling of `project`). Mirrors `projectCmd`'s shape/quality: bare
 * command prints help, --json everywhere, destructive remove gated behind --force/--yes. Because a process
 * cannot mutate its parent environment, `use` persists the selection AND prints the shell export line.
 */
export async function profileCmd(m: Mercury, a: Args): Promise<void> {
  void m; // profile management operates on the global profile registry, not the (already-selected) instance.
  const sub = a._[1];
  if (!sub || a.flags.help) return out(PROFILE_HELP);
  const json = !!a.flags.json;
  const force = !!a.flags.force || !!a.flags.yes;
  const dir = profileRegistryDir();

  switch (sub) {
    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const rows = listProfiles(dir);
      if (json) return out(rows, true);
      return out(rows.map(profileRow).join('\n'));
    }

    // ── create ───────────────────────────────────────────────────────────────
    case 'create': {
      const name = need(a._[2], 'mercury profile create <name> [--home <path>] [--desc <text>] [--use]');
      const profile = createProfile(dir, name, {
        home: flag(a, 'home'),
        description: flag(a, 'desc') ?? flag(a, 'description'),
        use: !!a.flags.use,
      });
      if (json) return out(profile, true);
      return out(
        `Created profile "${profile.name}" (home: ${profile.home}).` +
          (a.flags.use
            ? `\n  now active — to apply it to this shell now, run:\n    export ${PROFILE_ENV_VAR}=${profile.name}`
            : `\n  activate it with: mercury profile use ${profile.name}`),
      );
    }

    // ── use ───────────────────────────────────────────────────────────────
    case 'use': {
      const name = need(a._[2], 'mercury profile use <name>');
      const profile = useProfile(dir, name);
      if (json) return out({ active: profile.name, home: profile.home, export: `${PROFILE_ENV_VAR}=${profile.name}` }, true);
      return out(
        `Active profile is now "${profile.name}" (home: ${profile.home}).\n` +
          `New Mercury processes will use it automatically. To apply it to your CURRENT shell now, run:\n` +
          `    export ${PROFILE_ENV_VAR}=${profile.name}`,
      );
    }

    // ── show ───────────────────────────────────────────────────────────────
    case 'show': {
      const details = showProfile(dir, a._[2]);
      const enriched = { ...details, homeEntries: profileHomeEntryCount(details.home) };
      if (json) return out(enriched, true);
      return out(
        [
          `name:        ${details.name}${details.isActive ? '  (active)' : ''}${details.builtin ? '  (built-in)' : ''}`,
          `home:        ${details.home}${details.homeExists ? '' : '  (missing)'}`,
          `entries:     ${enriched.homeEntries}`,
          `description: ${details.description ?? '(none)'}`,
          `created:     ${details.createdAt || '(built-in)'}`,
        ].join('\n'),
      );
    }

    // ── current ───────────────────────────────────────────────────────────────
    case 'current': {
      const name = activeProfileName(dir);
      if (json) return out({ active: name }, true);
      return out(name);
    }

    // ── remove ───────────────────────────────────────────────────────────────
    case 'remove': {
      const name = need(a._[2], 'mercury profile remove <name> [--force|--yes] [--purge]');
      if (name === DEFAULT_PROFILE_NAME) {
        process.exitCode = 1;
        throw new Error(`the "${DEFAULT_PROFILE_NAME}" profile cannot be removed`);
      }
      if (!force) {
        process.exitCode = 1;
        throw new Error(`refusing to remove profile "${name}" without --force (or --yes)`);
      }
      const result = removeProfile(dir, name, { purge: !!a.flags.purge });
      if (json) return out(result, true);
      return out(
        `Removed profile "${result.name}".` +
          `${result.purged ? ` Deleted its home dir (${result.home}).` : ` Kept its home dir (${result.home}); pass --purge to delete it.`}` +
          `${result.wasActive ? ` It was active; the default profile is active now.` : ''}`,
      );
    }

    default:
      out(PROFILE_HELP);
      process.exitCode = 1;
  }
}

const SECRETS_HELP = `usage: mercury secrets backends [--json]
       mercury secrets list [--json]
       mercury secrets get <ref> [--reveal] [--json]
       mercury secrets resolve [--config <path>] [--json]

External secret stores. Config values may embed secret REFERENCES instead of plaintext:
  \${SECRET:backend:key}   resolve <key> through the named <backend>
  \${SECRET:key}           resolve <key> through the default backend (config secrets.defaultBackend; env)
These are resolved at connect time (e.g. for MCP server env/args/headers) — coexisting with the MCP
preset \${ENV_VAR} substitution, which is left untouched.

Backends (configured in config secrets.*):
  env           Environment variables (always available).
  bitwarden     Bitwarden CLI — "bw get password <key>" (enable: secrets.bitwarden.enabled).
  onepassword   1Password CLI — "op read <op://vault/item/field>" (enable: secrets.onepassword.enabled).

  backends                    List configured backends and whether each is available.
    --json                    Emit as JSON.
  list                        List \${SECRET:...} references found in the live config, with resolve status.
    --json                    Emit as JSON.
  get <ref>                   Resolve a single reference (accepts "backend:key", "key" or a full
                              "\${SECRET:...}" wrapper). The value is MASKED by default.
    --reveal                  Print the raw secret value (sensitive — avoid in shared terminals/logs).
    --json                    Emit as JSON (value masked unless --reveal).
  resolve [--config <path>]   Scan a config file (or the live config) and report which references resolve.
    --config <path>           Scan this file instead of the live config.
    --json                    Emit as JSON.

SAFETY: values are never persisted or logged; output is masked unless you pass --reveal to "get".
Exit code is non-zero when "get" cannot resolve the reference, or when "list"/"resolve" finds any
unresolved reference.`;

/** Build a resolver from the live config's secrets section (real runner for external CLIs). */
const secretsResolver = (m: Mercury): SecretResolver =>
  secretResolverFromConfig(m.config.secrets, { runner: defaultSecretRunner });

/** A masked status report for one reference spec. Never includes the plaintext value. */
interface SecretRefReport {
  ref: string;
  backend: string;
  key: string;
  status: 'resolved' | 'unresolved';
  value: string; // always masked
  error?: string;
}

const reportRef = (resolver: SecretResolver, spec: string): SecretRefReport => {
  try {
    const { ref, value } = resolver.resolveRef(spec);
    return { ref: spec, backend: ref.backend, key: ref.key, status: 'resolved', value: maskSecret(value) };
  } catch (err) {
    // Re-parse for display without leaking anything; resolveRef only throws on backend/lookup problems.
    let backend = resolver.defaultBackend;
    let key = spec;
    const colon = spec.indexOf(':');
    if (colon > 0) {
      const prefix = spec.slice(0, colon);
      if (resolver.backendNames().includes(prefix) || ['bw', 'op', '1password'].includes(prefix.toLowerCase())) {
        backend = prefix;
        key = spec.slice(colon + 1);
      }
    }
    return { ref: spec, backend, key, status: 'unresolved', value: '', error: errorMessage(err) };
  }
};

const refRow = (r: SecretRefReport): string => {
  const status = r.status === 'resolved' ? 'resolved  ' : 'UNRESOLVED';
  const ref = `\${SECRET:${r.ref}}`.slice(0, 42).padEnd(42);
  const val = r.status === 'resolved' ? r.value : `(${r.error ?? 'not resolved'})`;
  return `${status} ${ref} ${val}`;
};

/**
 * `mercury secrets <backends|list|get|resolve>` — pluggable external secret stores. Config values may
 * embed `${SECRET:backend:key}` / `${SECRET:key}` references that resolve at connect time through the
 * `env` backend (always on) or the opt-in Bitwarden / 1Password CLIs. Mirrors the shape of the other
 * subcommands (bare command prints help, --json everywhere); values are masked unless `get --reveal`.
 */
export async function secretsCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1];
  if (!sub || a.flags.help) return out(SECRETS_HELP);
  const json = !!a.flags.json;
  const resolver = secretsResolver(m);

  switch (sub) {
    // ── backends ───────────────────────────────────────────────────────────────
    case 'backends': {
      const rows = resolver.backendNames().map((name) => {
        const b = resolver.backendFor(name);
        return { name: b.name, describe: b.describe, available: b.available(), default: b.name === resolver.defaultBackend };
      });
      if (json) return out(rows, true);
      return out(
        rows
          .map((r) => `${r.default ? '*' : ' '} ${r.name.padEnd(12)} ${r.available ? 'available    ' : 'unavailable  '} ${r.describe}`)
          .join('\n'),
      );
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const specs = scanSecretRefs(m.config);
      const reports = specs.map((s) => reportRef(resolver, s));
      if (reports.some((r) => r.status === 'unresolved')) process.exitCode = 1;
      if (json) return out(reports, true);
      if (!reports.length) return out('(no ${SECRET:...} references found in the live config)');
      return out(reports.map(refRow).join('\n'));
    }

    // ── get ───────────────────────────────────────────────────────────────
    case 'get': {
      const spec = unwrapSecretRef(need(a._[2], 'mercury secrets get <ref> [--reveal]'));
      const reveal = !!a.flags.reveal;
      try {
        const { ref, value } = resolver.resolveRef(spec);
        const display = reveal ? value : maskSecret(value);
        if (json) return out({ ref: spec, backend: ref.backend, key: ref.key, status: 'resolved', revealed: reveal, value: display }, true);
        return out(display);
      } catch (err) {
        process.exitCode = 1;
        if (json) return out({ ref: spec, status: 'unresolved', error: errorMessage(err) }, true);
        throw err;
      }
    }

    // ── resolve ───────────────────────────────────────────────────────────────
    case 'resolve': {
      const configPath = flag(a, 'config');
      const source: unknown = configPath ? readFileSync(configPath, 'utf8') : m.config;
      const specs = scanSecretRefs(source);
      const reports = specs.map((s) => reportRef(resolver, s));
      if (reports.some((r) => r.status === 'unresolved')) process.exitCode = 1;
      if (json) return out({ source: configPath ?? '(live config)', refs: reports }, true);
      if (!reports.length) return out(`(no \${SECRET:...} references found in ${configPath ?? 'the live config'})`);
      return out(`${configPath ?? '(live config)'}:\n${reports.map(refRow).join('\n')}`);
    }

    default:
      out(SECRETS_HELP);
      process.exitCode = 1;
  }
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

export const ACP_HELP = `usage: mercury acp [serve|info|methods] [--json] [--user <name>]

Expose Mercury over the Agent Client Protocol (ACP) so external clients (editors/IDEs such
as Zed) can open a session and drive the Mercury agent. ACP complements the MCP server: where
'mercury mcp serve' lets MCP clients call Mercury's tools, 'mercury acp serve' lets an ACP
client prompt the Mercury agent and reach the same tool surface.

Subcommands:
  serve       Run the ACP server over stdio (newline-delimited JSON-RPC 2.0). This is the mode
              an ACP client launches; it reads requests on stdin and writes responses +
              session/update notifications on stdout. Runs until stdin closes.
              Bind a specific user with --user <name> (defaults to the local admin).
  info        Show protocol version, capabilities and the implemented method surface (default).
  methods     List the JSON-RPC methods this server handles.

Wire surface (JSON-RPC 2.0 over stdio):
  initialize            negotiate protocol version + capabilities (no auth methods advertised)
  session/new           open a session -> { sessionId }
  session/list          list open sessions
  session/prompt        run one turn; streams session/update, answers { stopReason }
  session/cancel        (notification) abort the in-flight turn
  _mercury/tools/list   list Mercury tool specs (vendor extension)
  _mercury/tools/call   invoke one Mercury tool by name (vendor extension)

Note: session/load and auth/* are intentionally unsupported (loadSession=false, no auth).`;

/**
 * ACP server management. The blocking 'serve' stdio loop is launched from bin.ts (like 'mcp serve');
 * this command prints the protocol/capability info and method surface.
 */
export async function acpCmd(m: Mercury, a: Args): Promise<void> {
  if (a.flags.help) return out(ACP_HELP);
  const sub = a._[1] ?? 'info';
  const methods = [
    { method: 'initialize', kind: 'request', description: 'Negotiate protocol version and exchange capabilities.' },
    { method: 'session/new', kind: 'request', description: 'Open a conversation session; returns a sessionId.' },
    { method: 'session/list', kind: 'request', description: 'List open sessions.' },
    { method: 'session/prompt', kind: 'request', description: 'Run one prompt turn; streams session/update, returns a stopReason.' },
    { method: 'session/cancel', kind: 'notification', description: 'Abort the in-flight turn.' },
    { method: '_mercury/tools/list', kind: 'request', description: 'List Mercury tool specs (vendor extension).' },
    { method: '_mercury/tools/call', kind: 'request', description: 'Invoke one Mercury tool by name (vendor extension).' },
  ];
  if (sub === 'serve') {
    // The actual stdio loop is run by bin.ts. If this path is reached, print guidance.
    return out('Run `mercury acp serve` as a subprocess of an ACP client; it serves JSON-RPC over stdio until stdin closes.');
  }
  if (sub === 'methods') {
    if (a.flags.json) return out(methods, true);
    return out(methods.map((x) => `${x.method.padEnd(22)} ${x.kind.padEnd(12)} ${x.description}`).join('\n'));
  }
  // info (default)
  const info = {
    protocolVersion: ACP_PROTOCOL_VERSION,
    transport: 'stdio (newline-delimited JSON-RPC 2.0)',
    capabilities: { loadSession: false, authMethods: [], sessionCapabilities: { list: true }, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
    toolSurface: (m.tools.specs('mcp') ?? []).map((t) => t.name),
    methods: methods.map((x) => x.method),
    serve: 'mercury acp serve',
  };
  if (a.flags.json) return out(info, true);
  return out(
    [
      `Mercury ACP server (Agent Client Protocol)`,
      `  protocol version: ${info.protocolVersion}`,
      `  transport:        ${info.transport}`,
      `  capabilities:     loadSession=false, auth=none, session/list=yes`,
      `  methods:          ${info.methods.join(', ')}`,
      `  tool surface:     ${info.toolSurface.length} tool(s) reachable via _mercury/tools/*`,
      `  serve:            mercury acp serve   (launched by an ACP client over stdio)`,
    ].join('\n'),
  );
}

export const LSP_HELP = `usage: mercury lsp [serve|info|methods] [--json] [--user <name>]

Expose Mercury over the Language Server Protocol (LSP) so LSP-capable editors/IDEs (VS Code, Neovim,
Zed, …) can reach the Mercury agent + tool surface through their built-in language-server plumbing. LSP
complements the MCP and ACP servers: where 'mercury mcp serve' lets MCP clients call Mercury's tools and
'mercury acp serve' lets an ACP client prompt the agent, 'mercury lsp serve' exposes the same surface to
an LSP client.

Subcommands:
  serve       Run the LSP server over stdio (JSON-RPC 2.0 with Content-Length header framing). This is the
              mode an LSP client launches; it reads framed requests on stdin and writes framed responses +
              $/progress notifications on stdout. Runs until the client sends 'exit' or stdin closes.
              Bind a specific user with --user <name> (defaults to the local admin).
  info        Show protocol version, capabilities and the implemented method surface (default).
  methods     List the JSON-RPC methods this server handles.

Wire surface (JSON-RPC 2.0 over stdio, Content-Length framed):
  initialize                  negotiate capabilities -> { capabilities, serverInfo }
  initialized                 (notification) client ack
  shutdown                    request a clean shutdown (-> null)
  exit                        (notification) end the serve loop
  textDocument/didOpen        track an opened document
  textDocument/didChange      apply a full-text change to a tracked document
  textDocument/didClose       stop tracking a document
  workspace/executeCommand    run a Mercury command: ${LSP_COMMANDS.join(', ')}
  _mercury/agent/prompt       run one agent prompt turn (vendor extension)
  _mercury/tools/list         list Mercury tool specs (vendor extension)
  _mercury/tools/call         invoke one Mercury tool by name (vendor extension)

Note: agent output streams back during a turn as $/progress notifications. Document sync is full
(textDocumentSync.change = 1).`;

/**
 * LSP server management. The blocking 'serve' stdio loop is launched from bin.ts (like 'mcp serve' and
 * 'acp serve'); this command prints the protocol/capability info and method surface.
 */
export async function lspCmd(m: Mercury, a: Args): Promise<void> {
  if (a.flags.help) return out(LSP_HELP);
  const sub = a._[1] ?? 'info';
  const methods = [
    { method: 'initialize', kind: 'request', description: 'Negotiate capabilities; returns serverInfo + capabilities.' },
    { method: 'initialized', kind: 'notification', description: 'Client acknowledgement after initialize.' },
    { method: 'shutdown', kind: 'request', description: 'Request a clean shutdown (returns null).' },
    { method: 'exit', kind: 'notification', description: 'End the serve loop.' },
    { method: 'textDocument/didOpen', kind: 'notification', description: 'Track an opened document.' },
    { method: 'textDocument/didChange', kind: 'notification', description: 'Apply a full-text change to a tracked document.' },
    { method: 'textDocument/didClose', kind: 'notification', description: 'Stop tracking a document.' },
    { method: 'workspace/executeCommand', kind: 'request', description: `Run a Mercury command (${LSP_COMMANDS.join(', ')}).` },
    { method: '_mercury/agent/prompt', kind: 'request', description: 'Run one agent prompt turn (vendor extension).' },
    { method: '_mercury/tools/list', kind: 'request', description: 'List Mercury tool specs (vendor extension).' },
    { method: '_mercury/tools/call', kind: 'request', description: 'Invoke one Mercury tool by name (vendor extension).' },
  ];
  if (sub === 'serve') {
    return out('Run `mercury lsp serve` as a subprocess of an LSP client; it serves Content-Length-framed JSON-RPC over stdio until the client sends `exit` or stdin closes.');
  }
  if (sub === 'methods') {
    if (a.flags.json) return out(methods, true);
    return out(methods.map((x) => `${x.method.padEnd(26)} ${x.kind.padEnd(12)} ${x.description}`).join('\n'));
  }
  // info (default)
  const info = {
    protocolVersion: LSP_PROTOCOL,
    transport: 'stdio (JSON-RPC 2.0, Content-Length framed)',
    serverInfo: { name: 'mercury', version: lspPkgVersion() },
    capabilities: {
      textDocumentSync: { openClose: true, change: 1 },
      executeCommandProvider: { commands: [...LSP_COMMANDS] },
    },
    toolSurface: (m.tools.specs('mcp') ?? []).map((t) => t.name),
    methods: methods.map((x) => x.method),
    serve: 'mercury lsp serve',
  };
  if (a.flags.json) return out(info, true);
  return out(
    [
      `Mercury LSP server (Language Server Protocol)`,
      `  protocol version: ${info.protocolVersion}`,
      `  transport:        ${info.transport}`,
      `  serverInfo:       ${info.serverInfo.name} v${info.serverInfo.version}`,
      `  capabilities:     textDocumentSync(full), executeCommand=[${LSP_COMMANDS.join(', ')}]`,
      `  methods:          ${info.methods.join(', ')}`,
      `  tool surface:     ${info.toolSurface.length} tool(s) reachable via _mercury/tools/* and mercury.tools.*`,
      `  serve:            mercury lsp serve   (launched by an LSP client over stdio)`,
    ].join('\n'),
  );
}

/** Resolve the CLI package version for `serverInfo.version` (never hardcode; mirrors bin.ts). */
function lspPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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


export const MOA_HELP = `usage: mercury moa "<prompt>" [--proposers a,b,c] [--aggregator <slot>]
                    [--strategy synthesize|vote] [--system <text>] [--show-proposals] [--json]

Mixture-of-Agents — send the SAME prompt to several proposer model slots in parallel, collect their
proposals, then produce one final answer. A natural extension of the Jev router + teams: it reuses the
existing model-slot / LLM-gateway call path (routing, RBAC, budgets, usage ledger) rather than adding a
second LLM mechanism.

Strategies:
  synthesize   An aggregator model slot reads every proposal and writes the final answer (default).
  vote         Majority / self-consistency: the answer backed by the most proposers wins (ties broken
               by first appearance). No aggregator call is made.

Flags:
  --proposers a,b,c   Comma-separated proposer model slots ("<provider>/<model>" or "auto").
                      Defaults to config moa.proposers, else the default model. The same slot may be
                      repeated (useful for vote / self-consistency sampling).
  --aggregator <slot> Aggregator model slot for synthesize (default: config moa.aggregator).
  --strategy <s>      synthesize (default) or vote. Default: config moa.strategy.
  --system <text>     Optional system prompt prepended to every proposer.
  --show-proposals    Also print each proposer's answer (and failures) before the final answer.
  --json              Emit the full structured result (proposals, votes, counts, final answer).

A proposer that errors is captured (not fatal); the run proceeds with whatever succeeded. If EVERY
proposer fails, the command errors (exit nonzero). Note: proposer/aggregator calls hit real models when
run live — nothing is mocked here.`;

/** Render a human summary of an MoA result. */
function renderMoa(r: MoaResult, showProposals: boolean): string {
  const lines: string[] = [];
  if (showProposals) {
    lines.push('Proposals:');
    for (const p of r.proposals) {
      const detail = p.status === 'ok' ? String(p.answer).replace(/\s+/g, ' ').slice(0, 200) : `ERROR: ${p.error ?? 'unknown'}`;
      lines.push(`  ${`${p.slot}#${p.index}`.padEnd(28)} [${p.status}] ${detail}`);
    }
    lines.push('');
  }
  if (r.strategy === 'vote' && r.votes) {
    const winner = r.votes[0];
    lines.push(`vote — ${r.usedProposers} proposer(s) answered, ${r.votes.length} distinct answer(s); winner: ${winner?.count ?? 0} vote(s) [${(winner?.voters ?? []).join(', ')}]`);
  } else {
    lines.push(`synthesize — ${r.usedProposers} proposal(s) via ${r.aggregator}${r.failedProposers ? ` (${r.failedProposers} proposer(s) failed)` : ''}`);
  }
  lines.push('');
  lines.push(r.answer);
  return lines.join('\n');
}

/**
 * `mercury moa "<prompt>"` — run a Mixture-of-Agents query. Proposer/aggregator slots and strategy come
 * from flags, falling back to the `moa.*` config section, then the default model. The real model-call
 * runner is supplied by the runtime (`m.moaModelCall`), so every call flows through the normal LLM
 * gateway. Pure aggregation/voting logic lives in @mercury/core.
 */
export async function moaCmd(m: Mercury, a: Args): Promise<void> {
  if (a.flags.help) return out(MOA_HELP);
  const json = !!a.flags.json;
  const prompt = a._.slice(1).join(' ').trim();
  if (!prompt) throw new Error('usage: mercury moa "<prompt>" [--proposers a,b] [--aggregator <slot>] [--strategy synthesize|vote] [--show-proposals] [--json]');

  const cfg = m.config.moa;
  const flagProposers = flag(a, 'proposers');
  const listed = (flagProposers !== undefined ? flagProposers.split(',') : cfg.proposers).map((s) => s.trim()).filter(Boolean);
  const proposers = listed.length ? listed : [m.config.llm.defaultModel];
  const strategyRaw = (flag(a, 'strategy') ?? cfg.strategy).toLowerCase();
  if (strategyRaw !== 'synthesize' && strategyRaw !== 'vote') throw new Error(`invalid --strategy "${strategyRaw}" (use: synthesize, vote)`);
  const strategy = strategyRaw as MoaStrategy;
  const aggregator = flag(a, 'aggregator') ?? cfg.aggregator ?? m.config.llm.defaultModel;

  const principal = m.principalFor(flag(a, 'user'));
  const result = await runMoa(
    { prompt, proposers, strategy, aggregator, system: flag(a, 'system') },
    m.moaModelCall(principal),
  );
  if (json) return out(result, true);
  return out(renderMoa(result, !!a.flags['show-proposals']));
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


/** Resolve the Mercury version from the CLI package.json (same source as bin.ts `pkgVersion`). */
function cliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Human-ish byte formatter (e.g. 1536 -> "1.5 KB"). */
function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

const BACKUP_HELP = `usage: mercury backup [--out <file>] [--include-secrets] [--json]
       mercury backup inspect <file> [--json]
       mercury import <file> [--force] [--json]        (alias: mercury restore <file>)

Full-home backup / restore. A backup is a complete, integrity-checked snapshot of this instance's
Mercury home (${'~/.mercury'} by default) written as a gzipped-JSON '.mbak' archive: config, the memory
DB (+ -wal/-shm), skills, add-ins, permissions, plugins, wiki and bundles.

  backup                      Create a backup of the Mercury home in the current directory.
    --out <file>              Write the archive to <file> instead of the default timestamped name.
    --include-secrets         Also back up secret files (.env, audit.key). EXCLUDED by default.
    --json                    Emit the manifest + digest/signature as JSON.
  backup inspect <file>       Verify an archive (content digest, per-file hashes, signature,
                              compatibility) and print its metadata WITHOUT restoring. --json for JSON.
  import <file>               Restore an archive into the Mercury home. Refuses to overwrite existing
    --force                   files unless --force is given; --force first writes a pre-restore safety
    --json                    backup of the current home so the restore is reversible.

Secret-exclusion default: '.env' and 'audit.key' are skipped unless --include-secrets. Volatile files
(*.log, *.mbak, sockets, pids, temp files, node_modules/, .git/) are always excluded. The archive is
signed with this instance's audit key; a VALID signature confirms it came from this instance.

Tip: the backup works on a live server; the SQLite -wal/-shm sidecars are included. For a perfectly
consistent DB snapshot you may stop the server first, but it is not required.`;

/**
 * `mercury backup [...]` — create a full-home backup, or `mercury backup inspect <file>` to verify one.
 * Mirrors the shape/quality of `securityCmd` / `bundleCmd`.
 */
export async function backupCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1];
  if (a.flags.help) return out(BACKUP_HELP);

  const dataDir = m.config.dataDir;
  const version = cliVersion();
  const secret = loadOrCreateAuditKey(join(dataDir, 'audit.key'));
  const json = !!a.flags.json;

  // ── inspect ──────────────────────────────────────────────────────────────
  if (sub === 'inspect') {
    const file = need(a._[2], 'mercury backup inspect <file>');
    const archive = readArchiveFile(file);
    const integrity = verifyArchiveIntegrity(archive);
    const signaturePresent = !!archive.signature;
    const signatureValid = signaturePresent ? verifyArchive(archive, secret) : false;
    const compat = checkArchiveCompat(archive.manifest, version);
    if (json) {
      return out(
        {
          manifest: archive.manifest,
          digest: archive.digest,
          digestValid: integrity.digestValid,
          fileHashesValid: integrity.fileHashesValid,
          signaturePresent,
          signatureValid,
          compatible: compat.compatible,
          issues: [...integrity.issues, ...compat.issues],
        },
        true,
      );
    }
    const man = archive.manifest;
    const sig = !signaturePresent
      ? 'absent'
      : signatureValid
        ? 'VALID'
        : 'INVALID (archive likely came from a different instance, or was tampered with)';
    const lines = [
      `Backup archive "${file}"`,
      `  created:     ${man.createdAt}`,
      `  mercury:     v${man.mercuryVersion} (format v${man.formatVersion})`,
      `  files:       ${man.fileCount} (${humanBytes(man.totalBytes)})`,
      `  secrets:     ${man.includedSecrets ? 'INCLUDED (.env/audit.key)' : 'excluded'}`,
      `  digest:      ${archive.digest.slice(0, 16)}… (${integrity.digestValid ? 'valid' : 'INVALID'})`,
      `  file hashes: ${integrity.fileHashesValid ? 'valid' : 'INVALID'}`,
      `  signature:   ${sig}`,
      `  compatible:  ${compat.compatible ? 'yes' : 'no'}`,
    ];
    const issues = [...integrity.issues, ...compat.issues];
    if (issues.length) lines.push(`  issues:      ${issues.join('; ')}`);
    return out(lines.join('\n'));
  }

  // ── create ───────────────────────────────────────────────────────────────
  const includeSecrets = !!a.flags['include-secrets'];
  const files = collectDataDir(dataDir, { includeSecrets });
  const archive = buildArchive(files, {
    mercuryVersion: version,
    dataDir,
    createdAt: new Date().toISOString(),
    includeSecrets,
    secret,
  });
  const outPath =
    flag(a, 'out') ?? join(process.cwd(), `mercury-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.mbak`);
  writeArchiveFile(outPath, archive);

  if (json) {
    return out({ manifest: archive.manifest, path: outPath, digest: archive.digest, signature: archive.signature }, true);
  }
  const lines = [
    `✓ Backup written to ${outPath}`,
    `  files:     ${archive.manifest.fileCount} (${humanBytes(archive.manifest.totalBytes)})`,
    `  secrets:   ${includeSecrets ? 'INCLUDED (.env/audit.key)' : 'excluded (use --include-secrets for a full DR snapshot)'}`,
    `  digest:    ${archive.digest.slice(0, 16)}…`,
    `  signature: ${archive.signature ? archive.signature.slice(0, 16) + '…' : '(none)'}`,
  ];
  return out(lines.join('\n'));
}

/**
 * `mercury import <file>` (alias `restore`) — restore a `.mbak` archive into the Mercury home.
 * Refuses to overwrite existing files without `--force`; `--force` first writes a pre-restore safety
 * backup of the current home so the operation is reversible. Integrity is verified before any write.
 */
export async function restoreCmd(m: Mercury, a: Args): Promise<void> {
  if (a.flags.help) return out(BACKUP_HELP);
  const file = need(a._[1], 'mercury import <file> [--force]   (alias: mercury restore <file>)');
  const dest = m.config.dataDir;
  const json = !!a.flags.json;
  const force = !!a.flags.force;

  const archive: BackupArchive = readArchiveFile(file);
  const plan = planRestore(archive, dest);

  if (plan.willOverwrite.length > 0 && !force) {
    throw new Error(
      `restore would overwrite ${plan.willOverwrite.length} existing file(s) in ${dest}. ` +
        `Re-run with --force to proceed (--force first writes a pre-restore safety backup you can roll back to).`,
    );
  }

  // With --force and existing files, snapshot the current home first (secrets included) so the
  // operation is reversible.
  let preRestoreBackup: string | undefined;
  if (force && plan.willOverwrite.length > 0) {
    try {
      const current = collectDataDir(dest, { includeSecrets: true });
      const secret = loadOrCreateAuditKey(join(dest, 'audit.key'));
      const safety = buildArchive(current, {
        mercuryVersion: cliVersion(),
        dataDir: dest,
        createdAt: new Date().toISOString(),
        includeSecrets: true,
        secret,
      });
      const baseDir = (() => {
        try {
          return dirname(dest);
        } catch {
          return process.cwd();
        }
      })();
      preRestoreBackup = join(baseDir, `mercury-prerestore-${new Date().toISOString().replace(/[:.]/g, '-')}.mbak`);
      writeArchiveFile(preRestoreBackup, safety);
    } catch (err) {
      throw new Error(`failed to write pre-restore safety backup (aborting restore): ${(err as Error).message}`);
    }
  }

  // restoreArchive verifies integrity (digest + every file hash) and throws before writing anything.
  const { restored } = restoreArchive(archive, dest);

  if (json) return out({ restored, preRestoreBackup }, true);
  const lines = [
    `✓ Restored ${restored.length} file(s) into ${dest}`,
    preRestoreBackup ? `  pre-restore safety backup: ${preRestoreBackup}` : `  (no existing files overwritten)`,
    `  Restart Mercury to pick up the restored config and data.`,
  ];
  return out(lines.join('\n'));
}



const SESSIONS_HELP = `usage: mercury sessions list [--limit <n>] [--search <text>] [--json]
       mercury sessions rename <id> <new-title> [--json]
       mercury sessions export <id> [--format json|md] [--out <path>] [--json]
       mercury sessions delete <id> [--force|--yes] [--json]
       mercury sessions prune [--older-than <dur|ISO>] [--keep <n>] [--empty] [--force|--yes] [--json]

Manage the chat sessions already persisted in the Mercury memory DB (${'~/.mercury'}/mercury.db). This is a
read/manage surface over EXISTING session data — it never changes how sessions are written.

  list                        List persisted sessions, most-recent-first (id, title, updated, messages, model).
    --limit <n>               Show at most n sessions.
    --search <text>           Keep only sessions whose title contains <text> (case-insensitive).
    --json                    Emit the sessions as JSON.
  rename <id> <new-title>     Set/replace a session's title. <id> may be a unique id prefix.
  export <id>                 Export one session (metadata + messages) to stdout or a file.
    --format json|md          json (default) or a markdown transcript.
    --out <path>              Write to <path> instead of stdout.
    --json                    With --out, print the result summary as JSON.
  delete <id>                 Delete one session (and its messages). Requires --force/--yes.
    --force, --yes            Confirm the deletion (destructive).
  prune                       Bulk cleanup. DRY RUN by default — prints what WOULD be deleted.
    --older-than <dur|ISO>    Select sessions older than a duration (30d/12h/90m/2w) or ISO date.
    --keep <n>                Protect the n most-recent sessions; with no other criterion, select the rest.
    --empty                   Select sessions with zero messages.
    --force, --yes            Actually delete the selected sessions (otherwise it is a dry run).
    --json                    Emit the selection/result as JSON.

Ids shown in the table are shortened; you may pass the short id (a unique prefix) to any subcommand.`;

/** Short id for tables (first 12 chars), mirroring how other commands abbreviate ids. */
const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 12) : id);

/** A session's recency timestamp, trimmed to minutes for the human table. */
const sessionRow = (s: Session): string => {
  const updated = (s.updatedAt || s.createdAt || '').slice(0, 16).replace('T', ' ');
  const msgs = String(s.messageCount ?? 0).padStart(5);
  const model = s.model ? `  ${s.model}` : '';
  const cwd = workingDirOf(s);
  return `${shortId(s.id).padEnd(13)} ${updated.padEnd(17)} ${msgs}  ${(s.title || 'New chat').slice(0, 48).padEnd(48)}${model}${cwd ? `  ${cwd}` : ''}`;
};

/**
 * Resolve a session by exact id or unique prefix, setting a non-zero exit code and throwing a readable
 * error for not-found / ambiguous (consistent with the rest of the CLI).
 */
function resolveSession(all: Session[], idOrPrefix: string): Session {
  const found = findSession(all, idOrPrefix);
  if (found === 'ambiguous') {
    process.exitCode = 2;
    throw new Error(`session id "${idOrPrefix}" is ambiguous; use a longer prefix or the full id`);
  }
  if (!found) {
    process.exitCode = 2;
    throw new Error(`session not found: ${idOrPrefix}`);
  }
  return found;
}

/**
 * `mercury sessions <list|rename|export|delete|prune>` — management surface over the EXISTING persisted
 * sessions. Mirrors the shape/quality of `backupCmd` / `securityCmd` (bare command prints help, --json
 * everywhere, destructive ops gated behind --force/--yes, non-zero exit on not-found).
 */
export async function sessionsCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1];
  if (!sub || a.flags.help) return out(SESSIONS_HELP);
  const json = !!a.flags.json;
  const force = !!a.flags.force || !!a.flags.yes;
  const store = m.memory.episodic;

  switch (sub) {
    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const all = store.listAll();
      const limit = flag(a, 'limit') !== undefined ? Math.max(0, Number(flag(a, 'limit'))) : undefined;
      const search = flag(a, 'search');
      const rows = filterSessions(all, { limit, search });
      if (json) return out(rows, true);
      if (!rows.length) return out('(no sessions)');
      const header = `${'ID'.padEnd(13)} ${'UPDATED'.padEnd(17)} ${'MSGS'.padStart(5)}  ${'TITLE'.padEnd(48)}  MODEL/CWD`;
      return out([header, ...rows.map(sessionRow)].join('\n'));
    }

    // ── rename ───────────────────────────────────────────────────────────────
    case 'rename': {
      const idArg = need(a._[2], 'mercury sessions rename <id> <new-title>');
      const title = a._.slice(3).join(' ');
      if (!title) throw new Error('usage: mercury sessions rename <id> <new-title>');
      const target = resolveSession(store.listAll(), idArg);
      const updated = store.updateSession(target.id, { title });
      if (!updated) {
        process.exitCode = 2;
        throw new Error(`session not found: ${idArg}`);
      }
      if (json) return out({ id: updated.id, title: updated.title }, true);
      return out(`✓ renamed ${shortId(updated.id)} → "${updated.title}"`);
    }

    // ── export ───────────────────────────────────────────────────────────────
    case 'export': {
      const idArg = need(a._[2], 'mercury sessions export <id> [--format json|md] [--out <path>]');
      const target = resolveSession(store.listAll(), idArg);
      const messages = store.messages(target.id, 100000);
      const format = (flag(a, 'format') ?? 'json').toLowerCase();
      if (format !== 'json' && format !== 'md' && format !== 'markdown') {
        throw new Error(`unknown --format "${format}" (use json or md)`);
      }
      const isMd = format === 'md' || format === 'markdown';
      const body = isMd
        ? renderSessionMarkdown(target, messages)
        : JSON.stringify(buildSessionExport(target, messages), null, 2);
      const outPath = flag(a, 'out');
      if (outPath) {
        writeFileSync(outPath, body);
        if (json) return out({ id: target.id, path: outPath, format: isMd ? 'md' : 'json', messages: messages.length }, true);
        return out(`✓ exported ${shortId(target.id)} (${messages.length} message(s), ${isMd ? 'md' : 'json'}) → ${outPath}`);
      }
      // stdout: print the raw document (json or markdown) so it is pipe-friendly.
      return console.log(body);
    }

    // ── delete ───────────────────────────────────────────────────────────────
    case 'delete': {
      const idArg = need(a._[2], 'mercury sessions delete <id> [--force|--yes]');
      const target = resolveSession(store.listAll(), idArg);
      if (!force) {
        throw new Error(
          `refusing to delete session ${shortId(target.id)} ("${target.title}") without confirmation. ` +
            `Re-run with --force (or --yes) to proceed.`,
        );
      }
      store.deleteSession(target.id);
      if (json) return out({ deleted: target.id, title: target.title }, true);
      return out(`✓ deleted ${shortId(target.id)} ("${target.title}")`);
    }

    // ── prune ───────────────────────────────────────────────────────────────
    case 'prune': {
      const all = store.listAll();
      const keepStr = flag(a, 'keep');
      const opts = {
        olderThan: flag(a, 'older-than'),
        keep: keepStr !== undefined ? Math.max(0, Number(keepStr)) : undefined,
        empty: !!a.flags.empty,
      };
      if (opts.olderThan === undefined && opts.keep === undefined && !opts.empty) {
        throw new Error('nothing to prune: pass at least one of --older-than <dur|ISO>, --keep <n>, --empty');
      }
      const selection = selectPrune(all, opts, new Date());
      const dryRun = !force;

      if (!dryRun) for (const d of selection.toDelete) store.deleteSession(d.session.id);

      if (json) {
        return out(
          {
            dryRun,
            criteria: opts,
            wouldDelete: selection.toDelete.map((d) => ({ id: d.session.id, title: d.session.title, messages: d.session.messageCount ?? 0, reasons: d.reasons })),
            deleted: dryRun ? [] : selection.toDelete.map((d) => d.session.id),
            keptCount: selection.kept.length,
          },
          true,
        );
      }
      const lines: string[] = [];
      lines.push(
        dryRun
          ? `DRY RUN — ${selection.toDelete.length} session(s) would be deleted, ${selection.kept.length} kept. Re-run with --force to apply.`
          : `✓ deleted ${selection.toDelete.length} session(s), ${selection.kept.length} kept.`,
      );
      for (const d of selection.toDelete) {
        lines.push(`  ${shortId(d.session.id)}  ${(d.session.title || 'New chat').slice(0, 40).padEnd(40)}  [${d.reasons.join(', ')}]`);
      }
      return out(lines.join('\n'));
    }

    default:
      return out(SESSIONS_HELP);
  }
}

const HOOKS_HELP = `usage: mercury hooks list [--json]
       mercury hooks events [--json]
       mercury hooks add <name> --event <event> --command <cmd> [--no-approval] [--disabled]
       mercury hooks remove <name> [--force]
       mercury hooks run <name> [--json]

Shell hooks run a configured shell command at a real lifecycle event (run start/end, tool
calls, memory writes, …). Every hook that shells out is routed through the approvals layer
BEFORE the command is spawned, unless you explicitly opt out with --no-approval.

The command receives context as environment variables: MERCURY_HOOK_EVENT and MERCURY_HOOK_TS are
always set; MERCURY_RUN_ID, MERCURY_SESSION_ID, MERCURY_USER_ID, MERCURY_TOOL, MERCURY_MODEL,
MERCURY_STATUS and MERCURY_PLATFORM are populated when the firing event carries them. Hooks are
stored in the config file under "hooks:" (type: shell).

  list                        List configured shell hooks (name, event, enabled, approval, command).
    --json                    Emit as JSON.
  events                      List the supported lifecycle event names a hook may bind to.
    --json                    Emit as JSON.
  add <name>                  Register (or overwrite) a shell hook.
    --event <event>           Lifecycle event to bind to (or "*" for every event). Required.
    --command <cmd>           Shell command to run. Required.
    --no-approval             Do NOT gate this hook through approvals (runs immediately).
    --disabled                Register the hook disabled (won't fire until re-enabled).
  remove <name>               Remove a shell hook (requires --force).
    --force                   Confirm removal.
  run <name>                  Manually fire a hook now for testing (still approval-gated).
    --json                    Emit the run result as JSON.

SAFETY: shell hooks execute arbitrary commands on the host. Approval gating is ON by default;
--no-approval disables it for a single hook — use only for trusted, non-destructive commands.`;

/** Shell lifecycle hooks: list / events / add / remove / run. */
export async function hooksCmd(m: Mercury, a: Args): Promise<void> {
  const sub = a._[1];
  if (!sub || a.flags.help) return out(HOOKS_HELP);
  const json = !!a.flags.json;
  const entries = [...((m.config.hooks ?? []) as HookConfigEntry[])];
  const persist = (next: HookConfigEntry[]): string => setConfigValue('hooks', next, m.configFile);

  switch (sub) {
    // ── events ───────────────────────────────────────────────────────────────
    case 'events': {
      if (json) return out([...HOOKS_EVENTS], true);
      return out([...HOOKS_EVENTS, '*'].map((e) => `  ${e}`).join('\n'));
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const defs = parseHookDefs(entries);
      if (json) return out(defs, true);
      return out(formatHookList(defs));
    }

    // ── add / set ───────────────────────────────────────────────────────────────
    case 'add':
    case 'set': {
      const name = need(a._[2], 'mercury hooks add <name> --event <event> --command <cmd>');
      const event = need(flag(a, 'event'), 'mercury hooks add <name> --event <event> --command <cmd>');
      const command = need(flag(a, 'command'), 'mercury hooks add <name> --event <event> --command <cmd>');
      const entry: HookConfigEntry = {
        type: 'shell',
        name,
        event,
        command,
        enabled: !a.flags.disabled,
        requiresApproval: !a.flags['no-approval'],
      };
      const v = validateHookDef(entry);
      if (!v.ok) {
        process.exitCode = 1;
        throw new Error(`invalid hook: ${v.errors.join('; ')}`);
      }
      const idx = entries.findIndex((e) => e.type === 'shell' && e.name === name);
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      const file = persist(entries);
      if (json) return out({ saved: file, hook: v.def, overwritten: idx >= 0 }, true);
      return out(`✓ ${idx >= 0 ? 'updated' : 'added'} shell hook "${name}" (${event}) → ${file}`);
    }

    // ── remove ───────────────────────────────────────────────────────────────
    case 'remove':
    case 'rm': {
      const name = need(a._[2], 'mercury hooks remove <name> --force');
      const idx = entries.findIndex((e) => e.type === 'shell' && e.name === name);
      if (idx < 0) {
        process.exitCode = 1;
        throw new Error(`no shell hook named "${name}"`);
      }
      if (!a.flags.force) {
        return out(`refusing to remove shell hook "${name}" without --force (re-run with --force to confirm)`);
      }
      entries.splice(idx, 1);
      const file = persist(entries);
      if (json) return out({ removed: name, saved: file }, true);
      return out(`✓ removed shell hook "${name}" → ${file}`);
    }

    // ── run / test ───────────────────────────────────────────────────────────────
    case 'run':
    case 'test': {
      const name = need(a._[2], 'mercury hooks run <name>');
      const defs = parseHookDefs(entries);
      const def = defs.find((d) => d.name === name);
      if (!def) {
        process.exitCode = 1;
        throw new Error(`no shell hook named "${name}"`);
      }
      const event: HooksEventName = def.event === '*' ? 'run_start' : def.event;
      let userId = 'system';
      try {
        userId = m.principalFor().userId;
      } catch {
        // No users yet: run under the system principal.
      }
      const plan = buildHookPlan(def, event, { userId, platform: 'cli' });
      const result = await runHookPlan(plan, {
        runner: defaultHookRunner,
        approver: (req, meta) => m.approvals.request(req, meta),
        defaultUserId: userId,
        defaultPlatform: 'cli',
      });
      if (result.status !== 'ok') process.exitCode = 1;
      if (json) return out(result, true);
      const lines = [formatHookResult(result)];
      if (result.stdout) lines.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
      if (result.stderr) lines.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
      return out(lines.join('\n'));
    }

    default:
      out(HOOKS_HELP);
      process.exitCode = 1;
  }
}


// ───────────────────────────── operator conveniences (gap #20) ─────────────────────────────

export const COMPLETION_HELP = `mercury completion <bash|zsh|fish> — print a shell-completion script

Generates a completion script (from the real command list) and prints it to stdout, so you can source it
or save it where your shell loads completions from.

Usage:
  mercury completion bash > /etc/bash_completion.d/mercury      # or source from ~/.bashrc
  mercury completion zsh  > "\${fpath[1]}/_mercury"               # then restart your shell
  mercury completion fish > ~/.config/fish/completions/mercury.fish

Completes top-level commands and the common subcommands of each.`;

export function completionCmd(_m: Mercury, a: Args): void {
  if (a.flags.help) return out(COMPLETION_HELP);
  const shell = (a._[1] ?? '').toLowerCase() as CompletionShell;
  if (!COMPLETION_SHELLS.includes(shell)) {
    throw new Error(`usage: mercury completion <${COMPLETION_SHELLS.join('|')}>`);
  }
  console.log(generateCompletion(shell));
}

export const LOGS_HELP = `mercury logs — view recent Mercury activity

Reads the activity Mercury already records in the 'runs' table (one row per chat/run). Read-only; adds no
new log store.

Usage:
  mercury logs [--limit <n>] [--since <dur|ISO>] [--until <dur|ISO>] [--json]

Flags:
  --limit <n>    Show at most N rows, most-recent first (default 20)
  --since <d>    Only activity at/after this time — a duration (30d, 12h, 90m, 2w) or ISO date
  --until <d>    Only activity before this time — duration or ISO date
  --json         Emit the rows as JSON

Note: this is a point-in-time view; there is no live --follow tail (runs are persisted after they finish).
An empty result prints "no activity recorded" and exits 0.`;

export function logsCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(LOGS_HELP);
  const json = !!a.flags.json;
  const limit = flag(a, 'limit') !== undefined ? Math.max(0, Number(flag(a, 'limit'))) : undefined;
  if (limit !== undefined && Number.isNaN(limit)) throw new Error('invalid --limit (expected a number)');
  const { sinceIso, untilIso } = resolveOperatorLogRange({ since: flag(a, 'since'), until: flag(a, 'until') });
  const rows = queryOperatorLogs(m.db, { sinceIso, untilIso, limit });
  if (json) return out(rows, true);
  return out(formatOperatorLogs(rows));
}

export const PROMPT_SIZE_HELP = `mercury prompt-size — estimate the size of the assembled system prompt/context

Measures the real, offline-available components of the system prompt the agent assembles (persona, the
security instruction hierarchy, and the skills/tools index) and reports characters plus an approximate
token count per component.

Usage:
  mercury prompt-size [--json]

Approximation note: token counts are a heuristic (~4 characters per token), NOT a tokenizer, and the
session-dependent pieces (conversation memory, retrieved context, per-turn hints) are shown as 0 here
because they only exist during a live run. Treat the totals as a lower-bound estimate of the static base
prompt, not an exact per-request figure.`;

export function promptSizeCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(PROMPT_SIZE_HELP);
  const json = !!a.flags.json;
  const persona = m.personalities.get(m.config.agent.personality).prompt;
  const skillsIndex = m.skills.index('cli');
  const report = computePromptSize([
    { name: 'system prompt (persona)', text: persona },
    { name: 'instruction hierarchy', text: INSTRUCTION_HIERARCHY },
    { name: 'skills/tools index', text: skillsIndex },
    { name: 'memory/context (live only)', text: '' },
  ]);
  if (json) return out(report, true);
  out(formatPromptSize(report));
  out('\n(approximate: ~4 chars/token; memory & retrieved context are live-run only. See: mercury prompt-size --help)');
}

export const MIGRATE_HELP = `mercury migrate — report or apply database migrations

Reuses the existing migration runner and the append-only migration list; adds no new migrations.

Usage:
  mercury migrate [status] [--json]   Show applied vs pending migrations
  mercury migrate up [--json]         Apply any pending migrations

Note: the database runs its migrations automatically when Mercury starts, so in normal operation nothing
is pending and 'migrate up' simply confirms the schema is current.`;

export function migrateCmd(m: Mercury, a: Args): void {
  if (a.flags.help) return out(MIGRATE_HELP);
  const json = !!a.flags.json;
  const sub = a._[1] ?? 'status';
  if (sub === 'up') {
    const appliedNow = applyPendingMigrations(m.db);
    const status = readMigrationStatus(m.db);
    if (json) return out({ applied: appliedNow, status }, true);
    if (!appliedNow.length) return out(`already up to date (${status.current}/${status.total} migrations applied)`);
    return out(`applied ${appliedNow.length} migration(s): ${appliedNow.join(', ')} (now ${status.current}/${status.total})`);
  }
  if (sub !== 'status') throw new Error('usage: mercury migrate [status|up] [--json]');
  const status = readMigrationStatus(m.db);
  if (json) return out(status, true);
  const lines = [
    `migrations: ${status.applied.length} applied, ${status.pending.length} pending (of ${status.total})`,
    `current version: ${status.current}`,
  ];
  if (status.pending.length) lines.push(`pending: ${status.pending.join(', ')}`);
  else lines.push('status: up to date');
  return out(lines.join('\n'));
}

export const CONSOLE_HELP = `mercury console — a lightweight operator REPL

Launches the interactive chat REPL with an operator banner (version, user, data dir, database path and a
config summary). Equivalent to 'mercury chat' plus the banner; all REPL slash-commands (/help, /model,
/usage, ...) are available.

Usage:
  mercury console [--user <name>] [--model <id>] [--session <id>] [--pattern <name>]`;

export async function consoleCmd(m: Mercury, a: Args): Promise<void> {
  if (a.flags.help) return out(CONSOLE_HELP);
  const principal = flag(a, 'user') ? m.principalFor(flag(a, 'user')) : await m.localPrincipal();
  const opts = { model: flag(a, 'model'), sessionId: flag(a, 'session'), pattern: flag(a, 'pattern') };
  console.log(
    operatorBanner({
      version: cliVersion(),
      dbPath: m.db.file,
      dataDir: m.config.dataDir || '(default)',
      model: opts.model ?? m.config.llm.defaultModel,
      personality: m.config.agent.personality,
      pattern: opts.pattern,
      user: principal.username,
    }),
  );
  await repl(m, principal, opts);
  await m.agent.idle();
}
