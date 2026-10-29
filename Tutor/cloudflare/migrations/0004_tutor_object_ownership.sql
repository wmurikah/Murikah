PRAGMA foreign_keys = ON;

-- Canonical ownership registry for every durable R2-backed Tutor object.
-- The existing persistence_objects table remains as the compatibility restore
-- manifest used by the pinned DeepTutor runtime. tutor_objects is the policy
-- layer: every durable object is explicitly owned and typed in D1.
CREATE TABLE IF NOT EXISTS tutor_objects (
  object_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'partner', 'admin', 'system')),
  owner_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  runtime_path TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_objects_owner
  ON tutor_objects(owner_kind, owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_objects_type
  ON tutor_objects(object_type, updated_at DESC);

-- Durable account/control-plane metadata. Authentication secrets/hashes remain
-- in the protected DeepTutor compatibility store and Cloudflare Secrets; D1
-- owns non-secret identity/role/status metadata.
CREATE TABLE IF NOT EXISTS tutor_accounts (
  actor_id TEXT PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('guest', 'member', 'admin')),
  account_status TEXT NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'disabled', 'deleted')),
  auth_provider TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES tutor_actors(actor_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_accounts_username
  ON tutor_accounts(username);

-- Security/audit trail for deployment-control changes and denied attempts.
CREATE TABLE IF NOT EXISTS tutor_access_audit (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'error')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_access_audit_actor
  ON tutor_access_audit(actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_access_audit_resource
  ON tutor_access_audit(resource, created_at DESC);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('ownership_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
