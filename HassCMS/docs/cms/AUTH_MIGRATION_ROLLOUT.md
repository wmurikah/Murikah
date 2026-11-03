# Reviewed authentication rollout

Use this guide for the audited existing CMS database. Migrations 001 and 002 are
retired: both files now return `BLOCKED_RETIRED_MIGRATION` without changing schema
or rows. Their unsafe historical SQL remains only in Git history and clearly
marked negative test fixtures. Do not run those historical versions on production.

## Supported code and database model

The [registration reconciliation](REGISTRATION_SCHEMA_RECONCILIATION.md),
[federated identity reconciliation](FEDERATED_IDENTITY_RECONCILIATION.md) and
[schema compatibility checks](SCHEMA_CONTRACT.md) already align current code with
the observed schema. Deploy those code changes before enabling repaired provider
flows. The reviewed target is `db/schema/cms.sql`; it is not a rollout script.

The audited schema needs no identity/request-table copy. Its only missing
authentication object was OIDC transaction storage. The replacement
`db/migrations/006_reviewed_auth_reconciliation.ts` checks this model and adds
only that table using the reviewed DDL from 003 if it is absent. If already
compatible, it changes nothing. No production data rewrite is necessary.

The explicit source-to-target mapping is preservation:

| Observed field/data                                     | Target behavior                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| access_request_id, federated_identity_id                | Preserve existing IDs and references                                                         |
| email_at_request, email_domain                          | Preserve values and NOCASE collations                                                        |
| identity_method=EMAIL_PASSWORD                          | Preserve EMAIL_PASSWORD; never rewrite to PASSWORD                                           |
| identity_method=GOOGLE/MICROSOFT/APPLE                  | Preserve method and linked identity; APPLE history is valid                                  |
| user_id                                                 | Preserve the existing user; do not infer a user from an email or create one for old requests |
| identity_verified_at=NULL                               | Preserve NULL; do not manufacture verification or make this field NOT NULL                   |
| provider, issuer, provider_subject                      | Preserve the qualified identity key; do not guess an issuer                                  |
| status, revoked_at, linked/created/review timestamps    | Preserve lifecycle/history, including revoked links and every request status                 |
| account/contact/reviewer/approved-membership references | Preserve all existing references                                                             |
| credentials, sessions, roles, memberships               | Preserve every row; migration creates no access grants                                       |

Current application registration separately creates an INVITED external applicant
and PENDING request in a transaction after verified provider authentication. It
issues no session, credential, role or membership. The rollout does not activate
historical pending applicants, reverify them or restore revoked identities.

## Preview and apply

1. Retain a database backup/export before maintenance and record the deployed code
   revision. Do not enable new SSO providers until compatibility and provider
   configuration are verified. This runner never changes provider configuration.
2. In an environment with Node 22+ and HassCMS dependencies, configure the existing
   `TURSO_CMS_DATABASE_URL` and `TURSO_CMS_AUTH_TOKEN` through variables/secrets.
   Do not commit credentials or put their values into the commands below.
3. From `HassCMS`, preview:

   ```sh
   npm run db:auth:review
   ```

   - `ALREADY_COMPATIBLE`: no authentication SQL is needed.
   - `READY_TO_ADD_OIDC`: the existing model and data checks pass, and only OIDC
     storage is missing.
   - `BLOCKED`: stop and inspect the table/requirement identifiers. No changes were
     made. Data-check output contains only issue counts, never customer values.

4. For `READY_TO_ADD_OIDC`, apply and recheck:

   ```sh
   npm run db:auth:review -- --apply
   npm run db:auth:review
   ```

   Expect `APPLIED`, then `ALREADY_COMPATIBLE`. Apply repeats all checks under a
   write transaction before creating anything and verifies the resulting contract
   before commit. Errors roll back the DDL. Existing compatible OIDC rows are never
   touched. If a connection fails during commit, rerun preview to establish the
   outcome before retrying. Use a low-activity period because apply takes a write
   lock. Do not combine this with other schema changes.

5. Check `/api/health` (200 with status `ok`), and the authorized
   `/api/admin/control/health` report's `schemaCompatibility`. Validate configured
   provider sign-in and a test registration; pending registration must remain
   ineligible for sign-in and portal access. Never test using real customer secrets.

Preview uses a read transaction. Both modes check the required table/column,
CHECK/UNIQUE/FK/default/collation contracts, unfinished 002 staging, scoped FK and
integrity checks, and request/identity user/provider consistency. Integrity/FK/data
checks perform several scans of authentication rows per run and can consume Turso row-read quota;
these are maintenance commands, not polling health checks. No row values are
logged. Identity revocation is retained rather than treated as bad history.

## Turso web console

The guarded runner is Node, not SQL to paste into the web editor. The updated
[`PHASE4_LIVE_VERIFICATION.sql`](PHASE4_LIVE_VERIFICATION.sql) provides read-only
web diagnostics using the current columns. It no longer selects nonexistent
request-provider fields or returns customer/provider identifiers. Its optional
data scans are marked explicitly.

On the confirmed observed model with only missing OIDC storage, standalone
[`003_oidc_transactions_only.sql`](../../db/migrations/003_oidc_transactions_only.sql)
is still the focused web-console DDL. Its ten-column count alone does not validate
constraints or existing request/identity data; use the full compatibility check
and review diagnostics first. The runner is preferred when a transactional,
automatically checked rollout is available. Never paste 001 or 002 historical DDL.

## Previously attempted or different schemas

The incident record states neither historical migration was run on production.
The replacement therefore targets the observed model and does not guess a
universal conversion for unrelated databases:

- Partial historical 001 can have added compatible OIDC storage and a non-unique
  helper index before failing its old `email` index. If the actual contracts and
  data now match, preview reports `ALREADY_COMPATIBLE` and preserves that index.
- An original 001 identity/request schema is blocked. Its missing issuer and
  identity lifecycle fields require reviewed provider-specific evidence; nullable
  request users require a row-specific identity/ownership decision. A future
  conversion would translate PASSWORD to EMAIL_PASSWORD only with that reviewed
  mapping, while preserving source rows/IDs and any fields absent from the target.
  This runner performs no such conversion and never links users by email alone.
- If historical 002 failed copying EMAIL_PASSWORD or NULL verification history,
  preserve both the source and `customer_access_requests_reconciled` staging
  table. Any staging object blocks this runner, even if empty. Inventory/compare
  both before designing recovery; do not drop staging automatically.
- If 002 already completed on an empty database, its request-table constraints
  still differ from current code's contract. Preview blocks it. Do not enable SSO
  or fabricate verified timestamps to make a copy succeed.

Do not remove constraints, discard Apple/password history, replace NULL timestamps
with current time, assign users by email or silently delete duplicates to force a
legacy database through. Recovery requires a separately reviewed source snapshot,
explicit mapping and preserved source data. Unknown or inconsistent shapes stay
unchanged and blocked rather than being described as repaired.

## Validation

`test/cms/authMigrationRollout.test.ts` uses a real local libSQL client and the
shared reviewed schema with synthetic populated records. It verifies every
existing table's rows and original schema objects survive the focused repair,
preview and reruns. Cases cover EMAIL_PASSWORD, NULL verification, all provider
methods and request statuses, nullable provider email, revoked identities, existing
credentials/sessions/grants, current repository registration/sign-in eligibility,
retired-script no-ops, partial 001, empty/failed 002, invalid data, and rollback
after OIDC creation. These are local tests, not a claim of a live migration.
