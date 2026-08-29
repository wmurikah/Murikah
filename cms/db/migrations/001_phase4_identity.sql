PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_federated_identities (
  identity_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT','APPLE')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT NOT NULL COLLATE NOCASE,
  provider_email_verified INTEGER NOT NULL CHECK(provider_email_verified IN (0,1)),
  provider_tenant_id TEXT,
  linked_at TEXT NOT NULL,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(provider, provider_subject),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_auth_federated_user ON auth_federated_identities(user_id);

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

CREATE TABLE IF NOT EXISTS customer_access_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  email_domain TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('PASSWORD','GOOGLE','MICROSOFT')),
  provider_subject TEXT,
  requested_account_id TEXT,
  company_name TEXT,
  contact_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by_user_id TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (requested_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_access_pending_email
  ON customer_access_requests(email) WHERE status = 'PENDING';
