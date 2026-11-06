import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

const sql = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  privilege_level TEXT NOT NULL CHECK (privilege_level IN ('STANDARD','PRIVILEGED','RESTRICTED')),
  ip_hash         TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT
);

CREATE TABLE IF NOT EXISTS auth_login_limits (
  scope            TEXT NOT NULL CHECK (scope IN ('ACCOUNT','IP')),
  key_hash         TEXT NOT NULL,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  blocked_until    TEXT,
  first_failure_at TEXT NOT NULL,
  last_failure_at  TEXT NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE TABLE IF NOT EXISTS auth_login_events (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_hash TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  org_id       TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','BLOCKED')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_auth_sessions_user_active ON auth_sessions(user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS ix_auth_login_events_account ON auth_login_events(account_hash, created_at);
CREATE INDEX IF NOT EXISTS ix_auth_login_events_ip ON auth_login_events(ip_hash, created_at);

CREATE TRIGGER IF NOT EXISTS trg_users_security_revoke
AFTER UPDATE OF status, is_platform_owner, deleted_at ON users
FOR EACH ROW
WHEN NEW.status <> OLD.status OR NEW.is_platform_owner <> OLD.is_platform_owner
  OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE users SET session_version = session_version + 1 WHERE id = NEW.id;
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         revoked_reason = CASE
           WHEN NEW.status <> OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at THEN 'user status changed'
           ELSE 'platform ownership changed'
         END
   WHERE user_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_organisations_security_revoke
AFTER UPDATE OF status, deleted_at ON organisations
FOR EACH ROW
WHEN NEW.status <> OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE users SET session_version = session_version + 1 WHERE org_id = NEW.id;
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_reason = 'organisation status changed'
   WHERE org_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_roles_security_insert
AFTER INSERT ON user_roles FOR EACH ROW
BEGIN
  UPDATE users SET session_version = session_version + 1 WHERE id = NEW.user_id;
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_reason = 'role assignment changed'
   WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_roles_security_delete
AFTER DELETE ON user_roles FOR EACH ROW
BEGIN
  UPDATE users SET session_version = session_version + 1 WHERE id = OLD.user_id;
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_reason = 'role assignment changed'
   WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_role_permissions_security_insert
AFTER INSERT ON role_permissions FOR EACH ROW
BEGIN
  UPDATE users SET session_version = session_version + 1
   WHERE id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id);
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_reason = 'role permissions changed'
   WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id) AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_role_permissions_security_delete
AFTER DELETE ON role_permissions FOR EACH ROW
BEGIN
  UPDATE users SET session_version = session_version + 1
   WHERE id IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id);
  UPDATE auth_sessions
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_reason = 'role permissions changed'
   WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id) AND revoked_at IS NULL;
END;
`;

export const sessionAndLoginSecurity: Migration = {
  id: '005',
  description: 'Add tracked sessions, revocation triggers and login throttling',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    await db.executeMultiple(sql);
  },
};
