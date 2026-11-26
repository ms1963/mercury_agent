/**
 * Operator conveniences (Tier-4 gap #20) — small, pure helpers backing five CLI commands:
 * `completion`, `logs`, `prompt-size`, `migrate` and `console`.
 *
 * Everything heavy here is a PURE function so it is fully unit-testable with no fs, no DB and no clock.
 * The only IO is a handful of thin, read-only query helpers over an existing {@link Db} (plus the
 * append-only migration reuse in {@link applyPendingMigrations}). No new schema and no new log store are
 * introduced: `logs` reads the `runs` table Mercury already writes, and `migrate` reuses the existing
 * {@link MIGRATIONS} array and `schema_migrations` bookkeeping.
 *
 * Exported names are prefixed (`Operator*` / `Completion*` / `Migration*` / `PromptSize*`) to avoid
 * barrel collisions with the other feature modules.
 */
import type { Db } from '../db/db.js';
import { MIGRATIONS } from '../db/migrations.js';
import { parseCutoff } from '../sessions/manage.js';

// ───────────────────────────── shell completion (pure) ─────────────────────────────

/** A supported completion shell. */
export type CompletionShell = 'bash' | 'zsh' | 'fish';

/** The supported shells, in help/validation order. */
export const COMPLETION_SHELLS: CompletionShell[] = ['bash', 'zsh', 'fish'];

/** One top-level command in the completion spec: its name, a short description and its subcommands. */
export interface CompletionCommand {
  name: string;
  desc: string;
  subs: string[];
}

/**
 * The curated command spec used to generate completions. Kept close to the `mercury --help` surface so
 * completions stay useful; subcommand lists mirror the dispatch in commands.ts.
 */
export const OPERATOR_COMMANDS: CompletionCommand[] = [
  { name: 'chat', desc: 'Interactive chat or one-shot message', subs: [] },
  { name: 'serve', desc: 'Start the HTTP API + web UI', subs: [] },
  { name: 'setup', desc: 'First-run wizard', subs: [] },
  { name: 'model', desc: 'Show or set the default model', subs: [] },
  { name: 'tools', desc: 'Manage tools', subs: ['list', 'toolsets', 'enable', 'disable'] },
  { name: 'skills', desc: 'Manage skills', subs: ['list', 'view', 'install'] },
  { name: 'learn', desc: 'What the agent learned', subs: ['stats', 'hints', 'playbooks'] },
  { name: 'schedule', desc: 'Scheduled tasks', subs: ['list', 'add', 'pause', 'resume', 'delete', 'run'] },
  { name: 'workflow', desc: 'Workflows', subs: ['list', 'run'] },
  { name: 'wiki', desc: 'Knowledge wiki', subs: ['init', 'status', 'ingest', 'query', 'lint'] },
  { name: 'addin', desc: 'Declarative add-ins', subs: ['list', 'scaffold'] },
  { name: 'bundle', desc: 'Agent bundles', subs: ['list', 'export', 'inspect', 'install'] },
  { name: 'memory', desc: 'Long-term memory & knowledge', subs: ['remember', 'recall', 'forget', 'ns', 'knowledge', 'audit'] },
  { name: 'team', desc: 'Multi-agent teams', subs: ['list', 'create', 'show', 'delete', 'run', 'runs'] },
  { name: 'moa', desc: 'Mixture-of-Agents', subs: [] },
  { name: 'perms', desc: 'Permission profiles', subs: ['list', 'show'] },
  { name: 'config', desc: 'Configuration', subs: ['path', 'get', 'set'] },
  { name: 'voice', desc: 'STT/TTS stack', subs: ['presets', 'show', 'use'] },
  { name: 'gateway', desc: 'Messaging gateway', subs: ['status', 'start', 'pending', 'pair'] },
  { name: 'mcp', desc: 'MCP connections', subs: ['status', 'serve', 'presets', 'enable', 'disable'] },
  { name: 'acp', desc: 'Agent Client Protocol', subs: ['serve', 'info', 'methods'] },
  { name: 'lsp', desc: 'Language Server Protocol', subs: ['serve', 'info', 'methods'] },
  { name: 'user', desc: 'User accounts', subs: ['list', 'add', 'passwd', 'role', 'delete'] },
  { name: 'token', desc: 'API tokens', subs: ['list', 'create', 'revoke'] },
  { name: 'audit', desc: 'Audit log', subs: ['list', 'verify'] },
  { name: 'security', desc: 'Supply-chain audit', subs: ['audit'] },
  { name: 'backup', desc: 'Back up the Mercury home', subs: ['inspect'] },
  { name: 'import', desc: 'Restore a backup archive', subs: [] },
  { name: 'restore', desc: 'Restore a backup archive', subs: [] },
  { name: 'sessions', desc: 'Manage chat sessions', subs: ['list', 'rename', 'export', 'delete', 'prune'] },
  { name: 'plugins', desc: 'Manage plugins', subs: ['list', 'install', 'update', 'remove'] },
  { name: 'profile', desc: 'Isolated instances', subs: ['list', 'create', 'use', 'show', 'current', 'remove'] },
  { name: 'project', desc: 'Named workspaces', subs: ['list', 'create', 'use', 'show', 'current', 'remove'] },
  { name: 'secrets', desc: 'External secret stores', subs: ['backends', 'list', 'get', 'resolve'] },
  { name: 'import-agent', desc: 'Import from Hermes Agent', subs: [] },
  { name: 'new', desc: 'Scaffold an extension', subs: [] },
  { name: 'replay', desc: 'Print a recorded run trace', subs: [] },
  { name: 'reliability', desc: 'SLOs, record/replay, chaos', subs: ['slo', 'record', 'recordings', 'replay', 'chaos'] },
  { name: 'proactive', desc: 'Event triggers & digest', subs: ['rules', 'events', 'digest', 'emit', 'flush', 'poll'] },
  { name: 'insights', desc: 'Usage analytics', subs: [] },
  { name: 'memory-graph', desc: 'Graph view over memory', subs: [] },
  { name: 'journey', desc: 'Chronological event timeline', subs: [] },
  { name: 'hooks', desc: 'Lifecycle hooks', subs: ['list', 'events', 'add', 'remove', 'run'] },
  { name: 'eval', desc: 'Self-evaluation suite', subs: [] },
  { name: 'completion', desc: 'Print a shell-completion script', subs: ['bash', 'zsh', 'fish'] },
  { name: 'logs', desc: 'View recent activity', subs: [] },
  { name: 'prompt-size', desc: 'Estimate assembled prompt size', subs: [] },
  { name: 'migrate', desc: 'Database migrations', subs: ['status', 'up'] },
  { name: 'console', desc: 'Operator REPL', subs: [] },
  { name: 'doctor', desc: 'Check the environment', subs: [] },
  { name: 'update', desc: 'Update Mercury', subs: [] },
  { name: 'help', desc: 'Show help', subs: [] },
  { name: 'version', desc: 'Print the version', subs: [] },
];

/** Generate a shell-completion script for the given shell from a command spec (PURE). */
export function generateCompletion(shell: CompletionShell, commands: CompletionCommand[] = OPERATOR_COMMANDS): string {
  switch (shell) {
    case 'bash':
      return bashCompletion(commands);
    case 'zsh':
      return zshCompletion(commands);
    case 'fish':
      return fishCompletion(commands);
  }
}

function bashCompletion(commands: CompletionCommand[]): string {
  const names = commands.map((c) => c.name).join(' ');
  const cases = commands
    .filter((c) => c.subs.length)
    .map((c) => `    ${c.name})\n      COMPREPLY=( $(compgen -W "${c.subs.join(' ')}" -- "$cur") ); return;;`)
    .join('\n');
  return `# bash completion for mercury — generated by 'mercury completion bash'
# Install: mercury completion bash > /etc/bash_completion.d/mercury   (or source it from ~/.bashrc)
_mercury_completion() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") ); return
  fi
  cmd="\${COMP_WORDS[1]}"
  case "$cmd" in
${cases}
  esac
}
complete -F _mercury_completion mercury
`;
}

function zshCompletion(commands: CompletionCommand[]): string {
  const topLines = commands.map((c) => `    '${c.name}:${c.desc.replace(/'/g, '')}'`).join('\n');
  const subCases = commands
    .filter((c) => c.subs.length)
    .map((c) => `        ${c.name}) compadd ${c.subs.join(' ')} ;;`)
    .join('\n');
  return `#compdef mercury
# zsh completion for mercury — generated by 'mercury completion zsh'
# Install: mercury completion zsh > "\${fpath[1]}/_mercury"   (then restart your shell)
_mercury() {
  local -a _cmds
  _cmds=(
${topLines}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'mercury command' _cmds
    return
  fi
  if (( CURRENT == 3 )); then
    case "\${words[2]}" in
${subCases}
    esac
  fi
}
_mercury "$@"
`;
}

function fishCompletion(commands: CompletionCommand[]): string {
  const lines: string[] = [
    '# fish completion for mercury — generated by \'mercury completion fish\'',
    '# Install: mercury completion fish > ~/.config/fish/completions/mercury.fish',
    'complete -c mercury -f',
  ];
  for (const c of commands) {
    lines.push(`complete -c mercury -n '__fish_use_subcommand' -a '${c.name}' -d '${c.desc.replace(/'/g, '')}'`);
  }
  for (const c of commands.filter((x) => x.subs.length)) {
    lines.push(`complete -c mercury -n '__fish_seen_subcommand_from ${c.name}' -a '${c.subs.join(' ')}'`);
  }
  return lines.join('\n') + '\n';
}

// ───────────────────────────── logs (thin read of the `runs` table) ─────────────────────────────

/** One activity row for the operator log view (a projection of the `runs` table). */
export interface OperatorLogRow {
  id: string;
  ts: string;
  kind: string;
  status: string;
  model?: string;
  sessionId?: string;
  userId?: string;
  summary: string;
}

/** Time-range + size filter for {@link queryOperatorLogs}. */
export interface OperatorLogRange {
  sinceIso?: string;
  untilIso?: string;
  /** Max rows (most-recent first); defaults to 20 when 0/undefined. */
  limit?: number;
}

/** Resolve `--since`/`--until` (a duration like `30d`/`12h` or an ISO date) to ISO bounds (pure, injected clock). */
export function resolveOperatorLogRange(
  spec: { since?: string; until?: string } = {},
  now: Date = new Date(),
): { sinceIso?: string; untilIso?: string } {
  const out: { sinceIso?: string; untilIso?: string } = {};
  if (spec.since) out.sinceIso = parseCutoff(spec.since, now).toISOString();
  if (spec.until) out.untilIso = parseCutoff(spec.until, now).toISOString();
  return out;
}

/** Clamp a free-form field to a single, length-bounded line for the table/summary (pure). */
export function oneLine(s: string | null | undefined, max = 60): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Read recent activity rows from the existing `runs` table, read-only. */
export function queryOperatorLogs(db: Db, range: OperatorLogRange = {}): OperatorLogRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (range.sinceIso) {
    where.push('started_at >= ?');
    params.push(range.sinceIso);
  }
  if (range.untilIso) {
    where.push('started_at < ?');
    params.push(range.untilIso);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = range.limit && range.limit > 0 ? Math.floor(range.limit) : 20;
  const sql = `SELECT id, started_at, kind, status, model, session_id, user_id, input, output
    FROM runs ${whereSql} ORDER BY started_at DESC LIMIT ${limit}`;
  const raw = db.all<{
    id: string;
    started_at: string;
    kind: string | null;
    status: string | null;
    model: string | null;
    session_id: string | null;
    user_id: string | null;
    input: string | null;
    output: string | null;
  }>(sql, ...params);
  return raw.map((r) => ({
    id: r.id,
    ts: r.started_at,
    kind: r.kind ?? 'run',
    status: r.status ?? '',
    model: r.model ?? undefined,
    sessionId: r.session_id ?? undefined,
    userId: r.user_id ?? undefined,
    summary: oneLine(r.input || r.output),
  }));
}

/** Render activity rows as a readable table (PURE). */
export function formatOperatorLogs(rows: OperatorLogRow[]): string {
  if (!rows.length) return 'no activity recorded';
  const head = `${'TIME'.padEnd(20)} ${'KIND'.padEnd(10)} ${'STATUS'.padEnd(9)} ${'SUMMARY'}`;
  const lines = rows.map((r) => {
    const t = (r.ts || '').replace('T', ' ').slice(0, 19);
    return `${t.padEnd(20)} ${r.kind.slice(0, 10).padEnd(10)} ${r.status.slice(0, 9).padEnd(9)} ${r.summary}`;
  });
  return [head, ...lines].join('\n');
}

// ───────────────────────────── prompt-size (pure sizing) ─────────────────────────────

/** One measured component of the assembled prompt/context. */
export interface PromptSizeComponent {
  name: string;
  chars: number;
  tokens: number;
}

/** The full prompt-size report: per-component sizes plus totals. */
export interface PromptSizeReport {
  components: PromptSizeComponent[];
  totalChars: number;
  totalTokens: number;
  /** True for a rough offline approximation (always true today — see the command help). */
  approximate: boolean;
}

/** Approximate the token count of a string (≈ 4 chars / token — an honest offline heuristic). */
export function approxTokens(chars: number): number {
  return Math.ceil((chars || 0) / 4);
}

/**
 * Compute a prompt-size report from named component strings (PURE). Empty/whitespace-only components are
 * kept (reported as 0) so the breakdown is stable. The token count is an approximation; see
 * {@link approxTokens}.
 */
export function computePromptSize(parts: { name: string; text: string }[]): PromptSizeReport {
  const components: PromptSizeComponent[] = parts.map((p) => {
    const chars = (p.text ?? '').length;
    return { name: p.name, chars, tokens: approxTokens(chars) };
  });
  const totalChars = components.reduce((a, c) => a + c.chars, 0);
  return { components, totalChars, totalTokens: approxTokens(totalChars), approximate: true };
}

/** Render a prompt-size report as a readable table (PURE). */
export function formatPromptSize(r: PromptSizeReport): string {
  const head = `${'COMPONENT'.padEnd(24)} ${'CHARS'.padStart(10)} ${'~TOKENS'.padStart(10)}`;
  const lines = r.components.map(
    (c) => `${c.name.slice(0, 24).padEnd(24)} ${c.chars.toLocaleString('en-US').padStart(10)} ${c.tokens.toLocaleString('en-US').padStart(10)}`,
  );
  const total = `${'TOTAL'.padEnd(24)} ${r.totalChars.toLocaleString('en-US').padStart(10)} ${r.totalTokens.toLocaleString('en-US').padStart(10)}`;
  return [head, ...lines, '', total].join('\n');
}

// ───────────────────────────── migrations (reuse existing runner) ─────────────────────────────

/** The applied-vs-pending report produced by {@link migrationStatus}. */
export interface MigrationStatusReport {
  /** Total migrations defined in the codebase ({@link MIGRATIONS}). */
  total: number;
  /** Highest applied version (0 when none). */
  current: number;
  /** Applied migration versions, ascending. */
  applied: number[];
  /** Pending (defined-but-not-applied) migration versions, ascending. */
  pending: number[];
  upToDate: boolean;
}

/** Compute applied-vs-pending migration status from the applied versions and the total defined (PURE). */
export function migrationStatus(appliedVersions: number[], total: number = MIGRATIONS.length): MigrationStatusReport {
  const appliedSet = new Set(appliedVersions);
  const applied: number[] = [];
  const pending: number[] = [];
  for (let v = 1; v <= total; v++) {
    if (appliedSet.has(v)) applied.push(v);
    else pending.push(v);
  }
  const current = applied.length ? Math.max(...applied) : 0;
  return { total, current, applied, pending, upToDate: pending.length === 0 };
}

/** Read the applied migration versions from the existing `schema_migrations` table, read-only. */
export function queryAppliedMigrations(db: Db): number[] {
  const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  return rows.map((r) => r.version);
}

/** Read the current migration status from an existing DB (thin wrapper over the query + pure status). */
export function readMigrationStatus(db: Db): MigrationStatusReport {
  return migrationStatus(queryAppliedMigrations(db), MIGRATIONS.length);
}

/**
 * Apply any pending migrations to an existing DB, reusing the append-only {@link MIGRATIONS} array and the
 * same `schema_migrations` bookkeeping as the boot-time runner (adds NO new migrations). Returns the list
 * of versions newly applied by this call. Note: `new Db()` already runs migrations at construction, so in
 * normal operation nothing is pending and this is a no-op that just confirms the DB is up to date.
 */
export function applyPendingMigrations(db: Db): number[] {
  const current = queryAppliedMigrations(db).reduce((m, v) => Math.max(m, v), 0);
  const appliedNow: number[] = [];
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, new Date().toISOString());
    });
    appliedNow.push(version);
  });
  return appliedNow;
}

// ───────────────────────────── console banner (pure) ─────────────────────────────

/** The pieces shown in the operator console banner. */
export interface OperatorBannerParts {
  version: string;
  dbPath: string;
  dataDir: string;
  model: string;
  personality: string;
  pattern?: string;
  user: string;
}

/** Build the operator console banner shown before the REPL starts (PURE). */
export function operatorBanner(p: OperatorBannerParts): string {
  return [
    `Mercury operator console — v${p.version}`,
    `  user:        ${p.user}`,
    `  data dir:    ${p.dataDir}`,
    `  database:    ${p.dbPath}`,
    `  model:       ${p.model}`,
    `  personality: ${p.personality}${p.pattern ? `  pattern: ${p.pattern}` : ''}`,
    `Type your message, or /help for REPL commands. Ctrl-D to exit.`,
  ].join('\n');
}
