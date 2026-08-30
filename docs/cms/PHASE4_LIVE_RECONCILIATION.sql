-- Phase 4 live-schema reconciliation.
-- WHAT: preserves and rebuilds only customer_access_requests, adds the missing
-- OIDC transaction table, and adds canonical request uniqueness indexes.
-- WHY: merged repository SQL and verified live Phase 4 columns drifted.
-- PRECONDITION: run only against the verified live Phase 4 shape documented in
-- docs/cms/PHASE4_AUTH_ARCHITECTURE.md. Do not run 001 first on that database.
-- Existing rows are copied before the Phase 4 request table is replaced.
-- POSTCONDITION: run PHASE4_LIVE_VERIFICATION.sql; copied counts must match,
-- foreign_key_check must return no rows, and integrity_check must return ok.

PRAGMA foreign_keys = ON;

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

CREATE TABLE customer_access_requests_reconciled (
  access_request_id TEXT PRIMARY KEY,
  user_id TEXT,
  identity_method TEXT NOT NULL CHECK(identity_method IN ('PASSWORD','GOOGLE','MICROSOFT')),
  federated_identity_id TEXT,
  provider_issuer TEXT,
  provider_subject TEXT,
  email_at_request TEXT NOT NULL COLLATE NOCASE,
  email_domain TEXT NOT NULL,
  requested_account_id TEXT,
  requested_contact_id TEXT,
  company_name TEXT,
  contact_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  submitted_at TEXT NOT NULL,
  identity_verified_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by_user_id TEXT,
  decision_reason TEXT,
  approved_membership_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (federated_identity_id) REFERENCES auth_federated_identities(federated_identity_id) ON DELETE SET NULL,
  FOREIGN KEY (requested_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (requested_contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (approved_membership_id) REFERENCES customer_portal_memberships(portal_membership_id) ON DELETE SET NULL
);

INSERT INTO customer_access_requests_reconciled (
  access_request_id,user_id,identity_method,federated_identity_id,provider_issuer,
  provider_subject,email_at_request,email_domain,requested_account_id,
  requested_contact_id,company_name,contact_name,status,submitted_at,
  identity_verified_at,reviewed_at,reviewed_by_user_id,decision_reason,
  approved_membership_id,created_at,updated_at
)
SELECT
  r.access_request_id,r.user_id,r.identity_method,r.federated_identity_id,
  f.issuer,f.provider_subject,r.email_at_request,r.email_domain,
  r.requested_account_id,r.requested_contact_id,r.company_name,NULL,r.status,
  r.submitted_at,r.identity_verified_at,r.reviewed_at,r.reviewed_by_user_id,
  r.decision_reason,r.approved_membership_id,r.created_at,r.updated_at
FROM customer_access_requests r
LEFT JOIN auth_federated_identities f
  ON f.federated_identity_id = r.federated_identity_id;

DROP TABLE customer_access_requests;
ALTER TABLE customer_access_requests_reconciled RENAME TO customer_access_requests;

CREATE UNIQUE INDEX uq_customer_access_pending_email
  ON customer_access_requests(email_at_request) WHERE status='PENDING';
CREATE UNIQUE INDEX uq_customer_access_pending_identity
  ON customer_access_requests(identity_method,provider_issuer,provider_subject)
  WHERE status='PENDING' AND provider_subject IS NOT NULL;
CREATE INDEX idx_customer_access_status_submitted
  ON customer_access_requests(status,submitted_at);
