-- Murikah database schema (Turso / libSQL).
-- Apply with:  pnpm db:apply   (or: turso db shell <db> < db/schema.sql)
-- Idempotent: safe to run repeatedly.

-- ===========================================================================
-- Marketing site tables (Prompt 1)
-- ===========================================================================

-- Contact form submissions.
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  organisation TEXT,
  role         TEXT,
  email        TEXT NOT NULL,
  message      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'contact',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);

-- Newsletter subscribers (email is unique; re-subscribing is idempotent).
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'website',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- Demo + assistant isolation (Prompt 3)
-- A demo session is a short-lived, anonymous container. We never store a raw
-- IP, only a salted hash, and a truncated user-agent. Everything a visitor
-- writes is scoped to their session_id and swept after 24 hours.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS demo_sessions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash      TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_created ON demo_sessions (created_at);

-- Document extraction runs (session-scoped). Uploaded bytes are NEVER stored;
-- only the structured result for a sample, or a transient upload's result.
CREATE TABLE IF NOT EXISTS demo_invoices (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  source         TEXT NOT NULL,
  filename       TEXT,
  extracted_json TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_invoices_session ON demo_invoices (session_id);
CREATE INDEX IF NOT EXISTS idx_demo_invoices_created ON demo_invoices (created_at);

-- Workflow demo runs (session-scoped).
CREATE TABLE IF NOT EXISTS demo_workflow_runs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  event_json      TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  log_json        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_workflow_session ON demo_workflow_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_demo_workflow_created ON demo_workflow_runs (created_at);

-- Mini-CRM demo (session-scoped).
CREATE TABLE IF NOT EXISTS demo_crm_contacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  company    TEXT NOT NULL,
  stage      TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_crm_contacts_session ON demo_crm_contacts (session_id);
CREATE INDEX IF NOT EXISTS idx_demo_crm_contacts_created ON demo_crm_contacts (created_at);

CREATE TABLE IF NOT EXISTS demo_crm_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  deal_id      TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_crm_events_session ON demo_crm_events (session_id);
CREATE INDEX IF NOT EXISTS idx_demo_crm_events_created ON demo_crm_events (created_at);

-- ===========================================================================
-- Read-only Audit OS seed (NOT session-scoped; shared sample data, no visitor
-- can mutate it). The app also ships this data as constants, so the sandbox
-- works even before these tables are seeded.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS demo_findings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ref       TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL,
  area      TEXT NOT NULL,
  risk      TEXT NOT NULL,
  status    TEXT NOT NULL,
  owner     TEXT NOT NULL,
  due_date  TEXT,
  summary   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_workpapers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_ref TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_metrics (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_board_items (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  title  TEXT NOT NULL,
  status TEXT NOT NULL,
  note   TEXT NOT NULL
);

-- ===========================================================================
-- Assistant audit log (Prompt 3). Retained for 30 days, then swept.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_conv_session ON assistant_conversations (session_id);
CREATE INDEX IF NOT EXISTS idx_assistant_conv_created ON assistant_conversations (created_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tokens          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_conv ON assistant_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_created ON assistant_messages (created_at);
