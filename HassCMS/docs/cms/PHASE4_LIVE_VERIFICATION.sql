-- READ-ONLY Turso web-console diagnostics for the current observed model.
-- See AUTH_MIGRATION_ROLLOUT.md. These queries do not authorize a table rebuild.
-- No provider secrets, state/nonce/PKCE values, emails or subject IDs are returned.
SELECT name,type,sql FROM sqlite_schema
WHERE name IN ('auth_federated_identities','auth_email_domain_policies',
              'auth_oidc_transactions','customer_access_requests',
              'customer_access_requests_reconciled')
   OR (type='index' AND tbl_name IN ('auth_federated_identities','customer_access_requests'))
ORDER BY type,name;

PRAGMA table_info('auth_federated_identities');
PRAGMA index_list('auth_federated_identities');
PRAGMA foreign_key_list('auth_federated_identities');
PRAGMA table_info('auth_oidc_transactions');
PRAGMA index_list('auth_oidc_transactions');
PRAGMA table_info('customer_access_requests');
PRAGMA index_list('customer_access_requests');
PRAGMA foreign_key_list('customer_access_requests');

-- OPTIONAL one-off maintenance scans below: consume reads on auth data.
-- Run after confirming the current columns, not as a polling health monitor.
SELECT identity_method,status,
       identity_verified_at IS NULL AS verification_timestamp_missing,
       COUNT(*) AS request_count
FROM customer_access_requests
GROUP BY identity_method,status,identity_verified_at IS NULL
ORDER BY identity_method,status,verification_timestamp_missing;

SELECT provider,status,COUNT(*) AS identity_count
FROM auth_federated_identities GROUP BY provider,status ORDER BY provider,status;

SELECT 'request_foreign_key_violations' AS check_name,COUNT(*) AS issue_count
FROM pragma_foreign_key_check('customer_access_requests')
UNION ALL SELECT 'identity_foreign_key_violations',COUNT(*)
FROM pragma_foreign_key_check('auth_federated_identities');

-- All three issue counts must be zero. Revoked links can remain in history;
-- this does not activate them, change pending requests, or infer identity data.
SELECT COUNT(*) AS request_identity_mismatches
FROM customer_access_requests r
JOIN auth_federated_identities f ON f.federated_identity_id=r.federated_identity_id
WHERE r.identity_method<>'EMAIL_PASSWORD'
  AND (r.user_id<>f.user_id OR r.identity_method<>f.provider);
