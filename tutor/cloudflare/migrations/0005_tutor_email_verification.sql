PRAGMA foreign_keys = ON;

-- New-account email verification. Only an HMAC digest of the one-time code is
-- stored; plaintext codes exist only long enough to be sent by the Worker.
CREATE TABLE IF NOT EXISTS tutor_email_verifications (
  challenge_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('local_signup', 'social_signup')),
  provider TEXT NOT NULL DEFAULT '',
  requester_hash TEXT NOT NULL DEFAULT '',
  code_digest TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  send_count INTEGER NOT NULL DEFAULT 1 CHECK (send_count >= 1),
  expires_at INTEGER NOT NULL,
  resend_after INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tutor_email_verifications_email
  ON tutor_email_verifications(email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_email_verifications_requester
  ON tutor_email_verifications(requester_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_email_verifications_expiry
  ON tutor_email_verifications(expires_at);

-- Verified-email metadata is deliberately separate from password/auth secrets.
ALTER TABLE tutor_accounts ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE tutor_accounts ADD COLUMN email_verified_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tutor_accounts_email
  ON tutor_accounts(email);

INSERT INTO persistence_meta(key, value, updated_at)
VALUES ('email_verification_schema_version', '1', unixepoch())
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
