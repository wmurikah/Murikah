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

Start with the preview-first [authentication rollout](AUTH_MIGRATION_ROLLOUT.md).
It checks the reviewed identity/request model and existing data before any DDL.
If that model is confirmed and only `auth_oidc_transactions` is absent, the focused
SQL repair remains
[`003_oidc_transactions_only.sql`](../../db/migrations/003_oidc_transactions_only.sql)
in that database's Turso SQL console. It creates the missing table, preserves
existing tables and rows, and is safe to rerun. Its final verification query
must return `required_columns = 10`. No credentials, session tokens or PKCE
verifiers are returned by that query.

After deploying this application's updated health check, `GET /api/health`
checks the full reviewed authentication table contracts, including columns and
constraints. Missing or incompatible storage makes status `degraded` with HTTP 503.
The ten-column SQL count alone does not establish full compatibility.
An existing incompatible table needs separate review; `IF NOT EXISTS` does not
repair it.

This focused SQL repair resolves transaction creation/storage only. The
application reconciliations for [registration](REGISTRATION_SCHEMA_RECONCILIATION.md)
and [federated sign-in](FEDERATED_IDENTITY_RECONCILIATION.md) are separate code
changes; the SQL does not configure provider credentials. Full external
sign-in remains subject to those separate requirements. Do not enable a new
provider on the assumption that this table alone completes reconciliation.

For customer registration on the observed existing schema, deploy the
[registration reconciliation](REGISTRATION_SCHEMA_RECONCILIATION.md). No
request-table rebuild is needed; applicants with an old registration grant
must verify again with their provider after deployment.

`001_phase4_identity.sql` and `002_phase4_live_schema_reconciliation.sql` are retired.
Their files now return `BLOCKED_RETIRED_MIGRATION` and make no schema/data changes.
Do not retrieve their historical DDL for a live repair: 001 cannot reconcile the
observed request columns, and 002 can reject `EMAIL_PASSWORD`/NULL verification
history or leave an incompatible rebuilt table. Follow the reviewed rollout for
partial applications. Merging/deploying code does not execute manual migrations.
