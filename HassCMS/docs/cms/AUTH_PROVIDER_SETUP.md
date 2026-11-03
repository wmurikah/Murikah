# CMS identity provider setup

Register these exact callback paths on the public CMS origin:

- `/api/auth/oidc/google/callback`
- `/api/auth/oidc/microsoft/callback`
- `/api/auth/oidc/apple/callback` (Apple `form_post`)

Set Worker secrets with `wrangler secret put`; never put values in source:

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Microsoft Entra: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT` (defaults to organisational accounts)
- Apple: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
- Reset delivery: `CMS_AUTH_MAIL_ENDPOINT`, `CMS_AUTH_MAIL_SECRET`

Google and Microsoft registration applications must request only OpenID, email and profile claims. Provider email must be verified. Apple is enabled for sign-in/linking, not initial registration. Validate every development, staging and production redirect URI in its provider console. Rotate secrets using Worker secret versions, then test login before retiring the previous value.

## Missing OIDC transaction storage on an existing database

If the database already has identity/customer-request tables but lacks
`auth_oidc_transactions`, run only
[`003_oidc_transactions_only.sql`](../../db/migrations/003_oidc_transactions_only.sql)
in that database's Turso SQL console. It creates the missing table, preserves
existing tables and rows, and is safe to rerun. Its final verification query
must return `required_columns = 10`. No credentials, session tokens or PKCE
verifiers are returned by that query.

After deploying this application's updated health check, `GET /api/health`
reports **External sign-in storage** as applied only when all ten required
columns are present. Missing or partial storage makes the overall status
`degraded` (HTTP 200, preserving the health endpoint's existing convention).
An existing incompatible table needs separate review; `IF NOT EXISTS` does
not repair it.

This focused repair resolves transaction creation/storage only. It does not
reconcile federated identity keys, issuer/revocation handling or customer
registration fields, nor configure provider credentials. Full external
sign-in remains subject to those separate requirements. Do not enable a new
provider on the assumption that this table alone completes reconciliation.

For customer registration on the observed existing schema, deploy the
[registration reconciliation](REGISTRATION_SCHEMA_RECONCILIATION.md). No
request-table rebuild is needed; applicants with an old registration grant
must verify again with their provider after deployment.

The older `001_phase4_identity.sql` assumes its original baseline; it is not
an upgrade for existing tables with different column names.
`002_phase4_live_schema_reconciliation.sql` rebuilds customer-request data
and is not a prerequisite for this focused repair. Neither should be run
blindly against an existing database. Merging/deploying application code does
not execute any of these manual SQL files.
