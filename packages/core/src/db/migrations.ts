/**
 * Ordered SQL migrations. Never edit an applied migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', display_name TEXT, locale TEXT, disabled INTEGER NOT NULL DEFAULT 0,
  policy TEXT, created_at TEXT NOT NULL
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT,
  token_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT,
  last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE identities (
  platform TEXT NOT NULL, external_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT, created_at TEXT NOT NULL, PRIMARY KEY (platform, external_id)
);
CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, chat_id TEXT, display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', user_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, platform TEXT, model TEXT, pattern TEXT,
  personality TEXT, meta TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id, updated_at);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, name TEXT,
  attachments TEXT, untrusted INTEGER NOT NULL DEFAULT 0, run_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, user_id UNINDEXED);
CREATE TABLE facts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'global', kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL, tags TEXT, importance REAL NOT NULL DEFAULT 0.5, embedding TEXT, source TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_user ON facts(user_id, scope);
CREATE VIRTUAL TABLE facts_fts USING fts5(content, fact_id UNINDEXED, user_id UNINDEXED);
CREATE TABLE user_profile (user_id TEXT PRIMARY KEY, traits TEXT NOT NULL, observations TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE blackboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  author TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_blackboard_run ON blackboard(run_id);
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'chat', run_id TEXT, ts TEXT NOT NULL
);
CREATE INDEX idx_usage_user_ts ON usage(user_id, ts);
CREATE TABLE budgets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '*', period TEXT NOT NULL,
  max_tokens INTEGER, max_cost REAL, created_at TEXT NOT NULL
);
CREATE TABLE skill_stats (
  name TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, last_used TEXT, created_by TEXT
);
CREATE TABLE reflections (
  id TEXT PRIMARY KEY, run_id TEXT, user_id TEXT, session_id TEXT, score REAL, verdict TEXT, lessons TEXT,
  skill TEXT, data TEXT, created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, run_id TEXT, purpose TEXT, provider TEXT, model TEXT, question TEXT, answer TEXT,
  confidence REAL, outcome REAL, latency_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, parent_run_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, model TEXT, pattern TEXT, workflow TEXT, depth INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_runs_user ON runs(user_id, started_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT, user_id TEXT, type TEXT NOT NULL, ts TEXT NOT NULL,
  span_id TEXT, parent_span_id TEXT, data TEXT
);
CREATE INDEX idx_events_run ON events(run_id, ts);
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, nl TEXT,
  task TEXT NOT NULL, delivery TEXT, status TEXT NOT NULL DEFAULT 'active', next_run TEXT, last_run TEXT,
  max_retries INTEGER NOT NULL DEFAULT 2, budget TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE, started_at TEXT NOT NULL,
  ended_at TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, output TEXT, error TEXT
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, meta TEXT, created_at TEXT NOT NULL
);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, details TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE review_queue (
  id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, item TEXT NOT NULL, decision TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  /* 2: persistent fixed-window rate limiter */ `
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
`,
  /* 3: built-in verification — results + escalations (Feature: verification) */ `
CREATE TABLE verifications (
  id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, user_id TEXT, goal TEXT, passed INTEGER NOT NULL,
  confidence REAL NOT NULL, threshold REAL NOT NULL, escalated INTEGER NOT NULL DEFAULT 0,
  checks TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_verifications_task ON verifications(task_id, created_at);
CREATE TABLE escalations (
  id TEXT PRIMARY KEY, verification_id TEXT, task_id TEXT, run_id TEXT, user_id TEXT, reason TEXT,
  confidence REAL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX idx_escalations_status ON escalations(status, created_at);
`,
  /* 4: reliability — recorded runs for replay regression (Feature: reliability) */ `
CREATE TABLE recordings (
  id TEXT PRIMARY KEY, name TEXT, run_id TEXT, user_id TEXT, input TEXT NOT NULL, tool_calls TEXT NOT NULL,
  output TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_recordings_created ON recordings(created_at);
`,
  /* 5: proactive — event queue + digest batching (Feature: proactive) */ `
CREATE TABLE proactive_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, title TEXT, body TEXT,
  data TEXT, priority REAL NOT NULL DEFAULT 0.5, decision TEXT NOT NULL DEFAULT 'defer',
  status TEXT NOT NULL DEFAULT 'pending', rule TEXT, created_at TEXT NOT NULL, handled_at TEXT
);
CREATE INDEX idx_proactive_status ON proactive_events(status, created_at);
`,
  /* 6: learning from runs — auto-tuned routing stats + failure playbooks (Feature: learning) */ `
CREATE TABLE learning_route_stats (
  bucket TEXT NOT NULL, model TEXT NOT NULL, lane TEXT,
  runs INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
  cost_sum REAL NOT NULL DEFAULT 0, tokens_sum INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY (bucket, model)
);
CREATE INDEX idx_learning_route_bucket ON learning_route_stats(bucket);
CREATE TABLE learning_playbooks (
  id TEXT PRIMARY KEY, signature TEXT UNIQUE NOT NULL, error_sample TEXT, task_sample TEXT,
  remediation TEXT, occurrences INTEGER NOT NULL DEFAULT 1, successes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_learning_playbooks_updated ON learning_playbooks(updated_at);
`,
  /* 7: self-distilling skills — parameterized skills distilled from winning run traces (Feature: distill) */ `
CREATE TABLE distilled_skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, params TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending', source_runs TEXT NOT NULL DEFAULT '[]',
  uses INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  cost_sum REAL NOT NULL DEFAULT 0, tokens_sum INTEGER NOT NULL DEFAULT 0, last_used TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_distilled_skills_name ON distilled_skills(name);
CREATE INDEX idx_distilled_skills_status ON distilled_skills(status, updated_at);
`,
  /* 8: deterministic run replay & time-travel debugging — per-run trace metadata + fork lineage (Feature: replay) */ `
CREATE TABLE run_traces (
  run_id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, input TEXT,
  seed TEXT NOT NULL DEFAULT '{}', steps INTEGER NOT NULL DEFAULT 0,
  parent_run_id TEXT, from_step INTEGER, edits TEXT,
  deltas TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_run_traces_user ON run_traces(user_id, created_at);
CREATE INDEX idx_run_traces_parent ON run_traces(parent_run_id);
`,
  /* 9: evaluation-driven self-improvement — labeled eval suites + cases promoted from real runs (Feature: evals) */ `
CREATE TABLE eval_suites (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'default',
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_eval_suites_name ON eval_suites(name);
CREATE TABLE eval_cases (
  id TEXT PRIMARY KEY, suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  name TEXT NOT NULL, input TEXT NOT NULL, expected TEXT NOT NULL DEFAULT '{}',
  source_run_id TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_eval_cases_suite ON eval_cases(suite_id, created_at);
CREATE TABLE eval_scores (
  id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'default',
  pass_rate REAL NOT NULL DEFAULT 0, cost_per_task REAL NOT NULL DEFAULT 0,
  intervention_rate REAL NOT NULL DEFAULT 0, similarity REAL NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0, cases INTEGER NOT NULL DEFAULT 0, label TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_eval_scores_suite ON eval_scores(suite_id, created_at);
`,
  /* 10: governed auto-tune — versioned, reversible accepted config changes with before/after score (Feature: evals) */ `
CREATE TABLE tune_history (
  id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', patch TEXT NOT NULL DEFAULT '{}',
  previous TEXT NOT NULL DEFAULT '{}', baseline_score REAL NOT NULL DEFAULT 0,
  candidate_score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'accepted',
  reverted INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_tune_history_suite ON tune_history(suite_id, created_at);
`,
  /* 11: sharable agent bundles — idempotency/audit ledger for installed Mercury packs (Feature: bundles) */ `
CREATE TABLE installed_bundles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '0.0.0',
  digest TEXT NOT NULL, sections TEXT NOT NULL DEFAULT '[]', applied TEXT NOT NULL DEFAULT '{}',
  pending TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'installed',
  source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_installed_bundles_name ON installed_bundles(name, created_at);
`,
  /* 12: governed long-term memory — namespace dimension on facts + queryable audit ledger (Feature: memory) */ `
ALTER TABLE facts ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_facts_namespace ON facts(user_id, namespace, updated_at);
CREATE TABLE memory_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default', decision TEXT NOT NULL DEFAULT 'allow',
  reason TEXT NOT NULL DEFAULT '', target TEXT, redactions INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_audit_user ON memory_audit(user_id, created_at);
CREATE INDEX idx_memory_audit_ns ON memory_audit(namespace, created_at);
CREATE INDEX idx_memory_audit_action ON memory_audit(action, created_at);
`,
  /* 13: knowledge/RAG store — ingested, chunked, embedded sources with provenance (Feature: memory) */ `
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', uri TEXT NOT NULL DEFAULT '',
  chunk_ref TEXT NOT NULL DEFAULT '', chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL, embedding TEXT, tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_user ON knowledge(user_id, namespace, created_at);
CREATE INDEX idx_knowledge_source ON knowledge(user_id, namespace, source_id);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(content, chunk_id UNINDEXED, user_id UNINDEXED, namespace UNINDEXED);
`,
  /* 14: multi-agent orchestration — persisted team definitions (Feature: teams) */ `
CREATE TABLE teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT 'coordinator', members TEXT NOT NULL DEFAULT '[]',
  options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_teams_name ON teams(name);
`,
  /* 15: multi-agent orchestration — team run records (definitions, delegation trace, aggregation) (Feature: teams) */ `
CREATE TABLE team_runs (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL DEFAULT '', team_name TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL, strategy TEXT NOT NULL DEFAULT 'coordinator', status TEXT NOT NULL DEFAULT 'completed',
  output TEXT NOT NULL DEFAULT '', members INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, trace TEXT NOT NULL DEFAULT '[]',
  error TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL
);
CREATE INDEX idx_team_runs_team ON team_runs(team_id, started_at);
`,
];
