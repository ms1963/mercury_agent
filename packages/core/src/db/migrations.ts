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
];
