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

CREATE TRIGGER IF NOT EXISTS guest_prompt_guard
BEFORE INSERT ON guest_prompts
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM guest_sessions
      WHERE uid = NEW.uid
        AND expires_at > unixepoch()
    )
    THEN RAISE(ABORT, 'guest_session_expired')
  END;

  SELECT CASE
    WHEN (
      SELECT used_count >= prompt_limit
      FROM guest_sessions
      WHERE uid = NEW.uid
    )
    THEN RAISE(ABORT, 'guest_prompt_limit')
  END;
END;

CREATE TRIGGER IF NOT EXISTS guest_prompt_charge
AFTER INSERT ON guest_prompts
BEGIN
  UPDATE guest_sessions
  SET used_count = used_count + 1,
      updated_at = unixepoch()
  WHERE uid = NEW.uid;
END;

CREATE TRIGGER IF NOT EXISTS guest_prompt_release
AFTER DELETE ON guest_prompts
BEGIN
  UPDATE guest_sessions
  SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END,
      updated_at = unixepoch()
  WHERE uid = OLD.uid;
END;

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
