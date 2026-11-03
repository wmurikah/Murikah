-- Standalone repair for a database missing only OIDC transaction storage.
-- Run this file in the hass-cms Turso SQL console. No transaction wrappers
-- are needed. It neither rebuilds nor updates identity/customer-request data.
-- Do not run migration 001 or 002 as a prerequisite for this repair.

CREATE TABLE IF NOT EXISTS auth_oidc_transactions (
  transaction_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT','APPLE')),
  purpose TEXT NOT NULL CHECK(purpose IN ('SIGN_IN','REGISTER','LINK')),
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at >= created_at)
);

-- Read-only verification: required_columns must be 10.
-- IF NOT EXISTS preserves an existing table; it cannot repair a different shape.
SELECT COUNT(*) AS required_columns
FROM pragma_table_info('auth_oidc_transactions')
WHERE name IN (
  'transaction_id','provider','purpose','state_hash','nonce_hash',
  'pkce_verifier','return_path','created_at','expires_at','consumed_at'
);
