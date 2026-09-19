PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS persistence_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS persistence_objects (
  path TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ns INTEGER NOT NULL CHECK (mtime_ns >= 0),
  generation TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_persistence_objects_generation
  ON persistence_objects(generation);

CREATE TABLE IF NOT EXISTS persistence_replay (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_persistence_replay_expires
  ON persistence_replay(expires_at);

CREATE TABLE IF NOT EXISTS guest_sessions (
  uid TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  prompt_limit INTEGER NOT NULL DEFAULT 7 CHECK (prompt_limit > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS guest_prompts (
  uid TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, request_id),
  FOREIGN KEY (uid) REFERENCES guest_sessions(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_guest_prompts_uid
  ON guest_prompts(uid);

-- Keep the migration intentionally free of trigger bodies. Wrangler's D1
-- migration execution path rejected the previous multi-statement trigger
-- definitions with "incomplete input". Guest quota admission is enforced
-- atomically by a conditional INSERT in the Worker.
INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
