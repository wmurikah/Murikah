-- Murikah database schema (Turso / libSQL).
-- Apply with:  pnpm db:apply   (see README) — or pipe into the Turso CLI:
--   turso db shell <your-db> < db/schema.sql
-- Idempotent: safe to run repeatedly.

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

-- Placeholder for future Labs interactive sandboxes (Build Prompt 3+).
-- Not used by any current endpoint; reserved so the schema is forward-looking.
CREATE TABLE IF NOT EXISTS demo_sessions (
  id         TEXT PRIMARY KEY,
  demo       TEXT NOT NULL,
  state      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_expires ON demo_sessions (expires_at);
