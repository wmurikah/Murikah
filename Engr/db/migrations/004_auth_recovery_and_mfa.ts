import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

const sql = `
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('INVITE','RESET')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext   TEXT NOT NULL,
  secret_iv           TEXT NOT NULL,
  pending_expires_at  TEXT,
  enabled_at          TEXT,
  last_totp_step      INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_auth_tokens_user_purpose ON auth_tokens(user_id, purpose, used_at);
CREATE INDEX IF NOT EXISTS ix_mfa_recovery_user ON mfa_recovery_codes(user_id, used_at);
`;

export const authRecoveryAndMfa: Migration = {
  id: '004',
  description: 'Add single-use auth tokens and authenticator MFA',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    await db.executeMultiple(sql);
  },
};
