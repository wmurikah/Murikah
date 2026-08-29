-- READ-ONLY Drizzle Studio verification. No transaction statements.
SELECT name, type, sql FROM sqlite_master
WHERE name IN (
  'auth_federated_identities','auth_email_domain_policies',
  'auth_oidc_transactions','customer_access_requests',
  'uq_customer_access_pending_email','uq_customer_access_pending_identity',
  'idx_customer_access_status_submitted'
) ORDER BY type,name;

PRAGMA table_info('auth_federated_identities');
PRAGMA index_list('auth_federated_identities');
PRAGMA foreign_key_list('auth_federated_identities');
PRAGMA table_info('auth_email_domain_policies');
PRAGMA index_list('auth_email_domain_policies');
PRAGMA foreign_key_list('auth_email_domain_policies');
PRAGMA table_info('auth_oidc_transactions');
PRAGMA index_list('auth_oidc_transactions');
PRAGMA table_info('customer_access_requests');
PRAGMA index_list('customer_access_requests');
PRAGMA foreign_key_list('customer_access_requests');

SELECT 'auth_federated_identities' AS table_name, count(*) AS row_count FROM auth_federated_identities
UNION ALL SELECT 'auth_email_domain_policies', count(*) FROM auth_email_domain_policies
UNION ALL SELECT 'auth_oidc_transactions', count(*) FROM auth_oidc_transactions
UNION ALL SELECT 'customer_access_requests', count(*) FROM customer_access_requests;

SELECT policy_type,active,count(*) AS policy_count
FROM auth_email_domain_policies GROUP BY policy_type,active ORDER BY policy_type,active;
SELECT domain,policy_type,reason,active
FROM auth_email_domain_policies ORDER BY domain;
SELECT email_at_request,count(*) AS pending_count
FROM customer_access_requests WHERE status='PENDING'
GROUP BY email_at_request HAVING count(*)>1;
SELECT identity_method,provider_issuer,provider_subject,count(*) AS pending_count
FROM customer_access_requests
WHERE status='PENDING' AND provider_subject IS NOT NULL
GROUP BY identity_method,provider_issuer,provider_subject HAVING count(*)>1;

PRAGMA foreign_key_check;
PRAGMA integrity_check;
