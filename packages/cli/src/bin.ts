#!/usr/bin/env node
/** `mercury` command-line entry point. */
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger, setConfigValue, SYSTEM_PRINCIPAL } from '@mercury/core';
import { createMercury, type Mercury } from '@mercury/runtime';
import { startServer } from '@mercury/server';
import { serveStdio } from '@mercury/mcp';
import { flag, parseArgs, type Args } from './args.js';
import { chatOnce, repl } from './repl.js';
import * as cmd from './commands.js';

const HELP = `Mercury — agentic AI platform

Usage: mercury <command> [options]

  chat [message]            Interactive chat (or one-shot when a message is given)
                            --model <id> --session <id> --pattern <name> --user <name>
  serve [--port 3000]       Start the HTTP API + web UI (+ scheduler, gateway, MCP endpoint)
  setup                     First-run wizard (admin user, LLM provider)
                            non-interactive: --username --password --provider --model
  model [provider/model]    Show or set the default model
  tools [list|toolsets|enable|disable <name>]
  skills [list|view|install <src>]
  learn [stats [bucket]|hints <task>|playbooks]   What the agent learned from its runs (routing, hints, playbooks)
  schedule [list|add|pause|resume|delete|run]   e.g. schedule add --when "every day at 9am" Summarise news
  workflow [list|run <name> <input>]
  wiki [init|status|ingest <path|->|query "<q>"|lint [--delta] [--no-llm]]
  addin [list|scaffold <name>]   Manage declarative add-ins (tools/personalities/permissions)
  bundle [list|export <name>|inspect <file>|install <file>]
                            Export/install a signed, versioned agent bundle ("Mercury pack")
  memory [remember <text>|recall <query>|forget <id>|ns|knowledge add|knowledge search|audit]
                            Governed long-term memory & knowledge layer
  team [list|create <name>|show <id>|delete <id>|run <id> <task>|runs]
                            Multi-agent orchestration (teams)
  perms [list|show <personality>]   Inspect per-agent/personality permission profiles
  config [path|get <key>|set <key> <value>]
  voice [presets|show|use <stt|tts> <preset>]
                            Swap the STT/TTS stack in one step (openai, speaches,
                            whisper, openedai, kokoro, piper, edge-tts)
  gateway [status|start|pending|pair <CODE>]
  mcp [status|serve|presets|enable <preset> [--name n] [--connect]|disable <server>]
                            MCP connections & optional integrations. 'presets' lists all curated
                            connectors (Slack, Notion, Postgres, Playwright, …) with provenance,
                            required env vars and on/off state; all are DISABLED by default.
                            'enable <preset>' turns one on, 'disable <server>' turns it off.
  user [list|add|passwd|role|delete]
  token [list|create <name> --scopes chat,mcp|revoke <id>]
  audit [list|verify] [--actor id] [--action token] [--since ISO] [--limit n] [--json]
  security [audit] [--npm] [--mcp] [--plugins] [--lockfile <path>] [--json]
                            Supply-chain CVE audit (OSV.dev) of npm deps, MCP servers & plugins
  backup [--out f] [--include-secrets]  Back up the full Mercury home (~/.mercury) to a .mbak archive
  backup inspect <file>     Verify a backup archive (digest, hashes, signature) without restoring
  import <file> [--force]   Restore a .mbak archive into the Mercury home (alias: restore)
  sessions [list|rename|export|delete|prune]   Manage persisted chat sessions
                            list [--limit n] [--search t]; rename <id> <title>; export <id> [--format md] [--out f];
                            delete <id> --force; prune [--older-than 30d] [--keep n] [--empty] [--force]  (--json everywhere)
  plugins                   List loaded plugins
  import-agent [~/.hermes]  Import memories, profile and skills from Hermes Agent
  new <tool|skill|workflow|adapter|plugin> <name> [--lang python|js|go|cpp|java]
  replay <runId>            Print the recorded event trace of a run
  reliability [slo|record <runId>|recordings|replay <recId>|chaos]
                            Per-agent SLOs, record/replay regression, chaos status
  proactive [rules|events|digest|emit <source> <kind>|flush|poll]
                            Event triggers, interrupt-vs-defer priority, digest queue
  eval [--tag <tag>] [--json]   Run the built-in self-evaluation suite (offline) with token/cost accounting
  doctor                    Check the environment
  update                    git pull + npm install + build
  help [topic]              Show help (topics: mercury help)
`;

async function boot(a: Args, services = false): Promise<Mercury> {
  return createMercury({ configFile: flag(a, 'config'), startServices: services, logger: createLogger((process.env.MERCURY_LOG_LEVEL as never) ?? 'warn') });
}

async function setup(m: Mercury, a: Args): Promise<void> {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (q: string, def = '') => flag(a, q.split(' ')[0]!.toLowerCase()) ?? (rl ? (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)) || def : def);
  try {
    if (m.users.count() === 0 || flag(a, 'username')) {
      const username = await ask('Username', 'admin');
      const password = await ask('Password (min 8 chars)');
      if (!password) throw new Error('a password is required (--password)');
      const existing = m.users.findByUsername(username);
      if (existing) m.users.setPassword(existing.id, password);
      else m.users.register(username, password, { role: 'admin' });
      console.log(`✔ admin user "${username}" ready`);
    }
    const provider = await ask('Provider (chatllm|openrouter|ollama|lmstudio|openai|anthropic|openai-compatible)', 'openrouter');
    const defaults: Record<string, string> = { chatllm: 'chatllm/route-llm', openai: 'openai/gpt-4o-mini', anthropic: 'anthropic/claude-3-5-haiku-latest', openrouter: 'openrouter/openai/gpt-4o-mini', ollama: 'ollama/llama3.1', lmstudio: 'lmstudio/local-model', 'openai-compatible': 'openai-compatible/local-model' };
    const model = await ask('Model', defaults[provider] ?? 'openrouter/openai/gpt-4o-mini');
    // Local / self-hosted providers need an explicit provider entry (base URL default is applied);
    // for openai-compatible the user must also set the base URL.
    if (provider === 'ollama' || provider === 'lmstudio') setConfigValue(`llm.providers.${provider}`, { type: provider, enabled: true }, m.configFile);
    if (provider === 'openai-compatible') {
      const baseUrl = await ask('Base URL (e.g. http://localhost:8000/v1)', 'http://localhost:8000/v1');
      setConfigValue('llm.providers.openai-compatible', { type: 'openai-compatible', baseUrl, enabled: true }, m.configFile);
    }
    const file = setConfigValue('llm.defaultModel', model, m.configFile);
    console.log(`✔ default model ${model} saved to ${file}`);
    if (['openai', 'anthropic', 'openrouter', 'chatllm'].includes(provider)) console.log(`  Put your API key in ~/.mercury/.env, e.g. ${provider.toUpperCase().replace('-', '_')}_API_KEY=...${provider === 'chatllm' ? '  (your Abacus.AI ChatLLM / RouteLLM key; ABACUS_API_KEY also works)' : ''}`);
    if (['ollama', 'lmstudio', 'openai-compatible'].includes(provider)) console.log(`  Make sure your local server is running and reachable.`);
    console.log('Next: `mercury chat` or `mercury serve` and open http://localhost:3000');
  } finally {
    rl?.close();
  }
}

/** Resolve the CLI package version from its package.json (never hardcode). */
function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const command = a._[0] ?? (a.flags.help ? 'help' : 'chat');
  if (command === 'new') return cmd.newCmd(a);
  if (command === 'version' || a.flags.v) return console.log(`mercury ${pkgVersion()}`);

  const serve = command === 'serve' || (command === 'mcp' && a._[1] === 'serve');
  const m = await boot(a, serve);
  try {
    switch (command) {
      case 'chat': {
        const principal = flag(a, 'user') ? m.principalFor(flag(a, 'user')) : await m.localPrincipal();
        const opts = { model: flag(a, 'model'), sessionId: flag(a, 'session'), pattern: flag(a, 'pattern') };
        const message = a._.slice(1).join(' ');
        if (message) await chatOnce(m, principal, message, opts);
        else await repl(m, principal, opts);
        await m.agent.idle();
        return;
      }
      case 'serve': {
        const port = Number(flag(a, 'port') ?? m.config.server.port);
        await startServer(m, { port, host: flag(a, 'host') });
        console.log(`Mercury listening on http://${flag(a, 'host') ?? m.config.server.host}:${port}  (MCP: ${m.config.mcp.server.path}, metrics: /metrics)`);
        if (m.users.count() === 0) console.log('No users yet — the first account registered in the web UI becomes admin.');
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        return;
      }
      case 'setup':
        return await setup(m, a);
      case 'model':
        if (a._[1]) return console.log(`default model saved to ${setConfigValue('llm.defaultModel', a._[1], m.configFile)}`);
        console.log(`default: ${m.config.llm.defaultModel}\n${m.providers.profilesList().map((p) => `  ${p.id}`).join('\n')}`);
        return;
      case 'tools':
        return await cmd.toolsCmd(m, a);
      case 'skills':
        return await cmd.skillsCmd(m, a);
      case 'learn':
        return await cmd.learnCmd(m, a);
      case 'schedule':
        return await cmd.scheduleCmd(m, a);
      case 'wiki':
        return await cmd.wikiCmd(m, a);
      case 'addin':
        return await cmd.addinCmd(m, a);
      case 'bundle':
        return await cmd.bundleCmd(m, a);
      case 'memory':
        return await cmd.memoryCmd(m, a);
      case 'team':
        return await cmd.teamCmd(m, a);
      case 'perms':
        return await cmd.permsCmd(m, a);
      case 'config':
        return await cmd.configCmd(m, a);
      case 'voice':
        return cmd.voiceCmd(m, a);
      case 'gateway':
        return await cmd.gatewayCmd(m, a);
      case 'user':
        return await cmd.userCmd(m, a);
      case 'token':
        return await cmd.tokenCmd(m, a);
      case 'audit':
        return await cmd.auditCmd(m, a);
      case 'security':
        return await cmd.securityCmd(m, a);
      case 'backup':
        return await cmd.backupCmd(m, a);
      case 'import':
      case 'restore':
        return await cmd.restoreCmd(m, a);
      case 'sessions':
        return await cmd.sessionsCmd(m, a);
      case 'plugins':
        return cmd.pluginsCmd(m);
      case 'import-agent':
        return await cmd.importAgent(m, a);
      case 'doctor':
        return await cmd.doctor(m);
      case 'update':
        return await cmd.updateCmd(m);
      case 'workflow': {
        if (a._[1] !== 'run') return console.log(m.workflows.list().map((w) => `${w.name.padEnd(24)} ${w.type.padEnd(18)} ${w.description ?? ''}`).join('\n'));
        const principal = await m.localPrincipal();
        const r = await m.workflows.run(a._[2] ?? '', a._.slice(3).join(' '), { principal, platform: 'cli' });
        return console.log(r.output);
      }
      case 'mcp':
        if (a._[1] === 'serve') {
          const principal = flag(a, 'user') ? m.principalFor(flag(a, 'user')) : { ...SYSTEM_PRINCIPAL, userId: (await m.localPrincipal()).userId };
          await serveStdio(m.mcpBackend(), principal);
          await new Promise(() => undefined);
        }
        return await cmd.mcpCmd(m, a);
      case 'replay':
        for (const e of m.recorder.replay(a._[1] ?? '')) console.log(`${e.ts} ${e.type.padEnd(16)} ${JSON.stringify(e.data).slice(0, 160)}`);
        return;
      case 'reliability': {
        const sub = a._[1];
        if (sub === 'slo') return console.log(JSON.stringify(m.slo.compute(flag(a, 'days') ? Number(flag(a, 'days')) : undefined), null, 2));
        if (sub === 'record') {
          const rec = m.runRecorder.record(a._[2] ?? '', flag(a, 'name'));
          return console.log(rec ? `recorded ${rec.id} (${rec.toolCalls.length} tool calls)` : 'run not found');
        }
        if (sub === 'recordings') return console.log(m.runRecorder.list().map((r) => `${r.id.padEnd(20)} ${(r.name ?? '').padEnd(26)} tools=${r.toolCalls.length}  ${r.createdAt}`).join('\n') || 'no recordings');
        if (sub === 'replay') {
          const d = await m.replay.replay(a._[2] ?? '');
          return console.log(`${d.match ? 'MATCH' : 'REGRESSION'} — ${d.summary}`);
        }
        if (sub === 'chaos') return console.log(JSON.stringify(m.chaos.status(), null, 2));
        return console.log('usage: mercury reliability <slo [--days N] | record <runId> [--name N] | recordings | replay <recordingId> | chaos>');
      }
      case 'proactive': {
        const sub = a._[1];
        if (sub === 'rules') return console.log(m.proactive.rules().map((r) => `${r.id.padEnd(18)} ${r.source}/${r.kind} → ${r.route || 'auto'} p=${r.priority}  ${r.description}`).join('\n') || 'no rules');
        if (sub === 'events') return console.log(m.proactive.events().map((e) => `${e.createdAt} ${e.decision.padEnd(9)} ${e.priority.toFixed(2)} ${e.source}/${e.kind}  ${e.title ?? ''}`).join('\n') || 'no events');
        if (sub === 'digest') return console.log(m.proactive.deferred().map((e) => `${e.createdAt} ${e.priority.toFixed(2)} ${e.source}/${e.kind}  ${e.title ?? ''}`).join('\n') || 'digest queue empty');
        if (sub === 'emit') {
          const ev = await m.proactive.ingest({ source: a._[2] ?? 'cli', kind: a._[3] ?? 'event', title: flag(a, 'title'), body: flag(a, 'body') });
          return console.log(`${ev.decision} (p=${ev.priority.toFixed(2)}) → ${ev.id}`);
        }
        if (sub === 'flush') return console.log((await m.proactive.flushDigest()).summary);
        if (sub === 'poll') return console.log(`polled ${(await m.proactive.poll()).polled} event(s)`);
        return console.log('usage: mercury proactive <rules | events | digest | emit <source> <kind> [--title T] [--body B] | flush | poll>');
      }
      case 'eval':
        return await cmd.evalCmd(m, a);
      case 'help':
        if (a._[1]) return console.log(m.help.get(a._[1]) ?? `No help topic "${a._[1]}". Topics:\n${m.help.index()}`);
        return console.log(`${HELP}\nHelp topics:\n${m.help.index()}`);
      default:
        console.error(`Unknown command "${command}".\n\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    await m.shutdown();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  },
);
