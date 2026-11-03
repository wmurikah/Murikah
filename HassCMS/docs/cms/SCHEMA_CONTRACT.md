# CMS schema compatibility

`db/schema/cms.sql` is the reviewed schema baseline. It contains the operator's
2 November 2026 schema export, with standalone OIDC repair 003, the read indexes
from 004 and the eight duplicate-index removals from 005. It includes the observed
identity/request, SLA, contact and survey definitions and SO/PO REAL/INTEGER
affinities and nullable row hashes. It contains no business or authentication
data. The extra email-domain/channel settings tables from the export are included.

**This reference file is not a production migration.** Do not paste it over an
existing database. Live changes require reviewed incremental migrations.

## One source for fixtures and checks

Every CMS integration fixture loads the baseline through
`test/cms/support/schema.ts`. Registration tests no longer replace two tables
with another DDL copy. The duplicate-index tests use the same baseline and add
the explicit recovery indexes only for the cleanup scenario. Test seeds use named
contact columns so the observed optional `portal_role` column is preserved.

`src/lib/cms/schema/contract.json` is generated from that baseline using SQLite's
metadata, not manually maintained. `npm test` first runs `db:schema:check` and
fails if the baseline and committed manifest differ. The compatibility tests then
check all 91 shared fixture tables and deliberately recreate the audited failures.
The missing-OIDC scenario explicitly removes the table; its presence in a target
fixture can no longer conceal the missing-production-table case.

When changing schema:

1. Review a fresh schema-only export or the proposed migration and reconcile it
   with application queries. Do not silently accept a snapshot as correct.
2. Update the reference SQL and the incremental rollout migration together.
3. From `HassCMS`, run `npm run db:schema:generate`, then commit the baseline and
   generated manifest together. `npm run db:schema:check` verifies synchronization.
4. Run affected workflow tests, schema-compatibility tests, the wider suite and
   the CMS build. A regenerated fixture alone cannot establish live compatibility.
5. Check the deployed database using the read-only check below before/after
   rollout. Review differences; do not automatically alter production to match.

## Runtime readiness

`GET /api/health` checks reachability and the contract for 14 audited tables:
users, OIDC transactions, federated links, access requests, contacts, invitations,
portal memberships, notifications and the SLA runtime/raw extract tables. Existing
source-completeness, portal visibility, named audit-trigger and assistant/channel
table prerequisites remain separate checks. The public route returns **503** when
schema is incompatible or cannot be checked, as well as when the database is down;
healthy readiness returns 200. This changes the previous degraded=200 behavior.

The public response contains generic check results and a trace ID. Schema issue
identifiers are logged server-side with that trace ID, never raw driver errors,
SQL, connection details or customer values. The endpoint stays unauthenticated
and uncached. `verifySlaTables` now checks the four SLA runtime table contracts
before the monitored page/API sweeps, rather than accepting names alone.

Checks cover required columns, declared types, nullability, defaults, primary-key
order, column collations, full/partial UNIQUE keys, CHECK expressions and foreign
key columns/actions. Index names are immaterial, and non-unique performance
indexes can be added/removed without changing compatibility. Unknown tables and
safe nullable/defaulted columns are allowed. Missing constraints, new constraints
that can reject application writes and new required columns without defaults are
reported. CHECK expressions are compared as normalized SQL tokens, retaining
literal values. Equivalent but differently expressed CHECKs can require review;
the checker does not attempt to prove arbitrary SQL logically equivalent.

Inspection takes one metadata-only query per scope. It does not count or scan
application rows, write probe records, rebuild indexes or cache readiness across
requests. Readiness checks a bounded scope; it is not a full-schema guarantee.

## Check the deployed database

For the full 91-table report, sign in with Control Centre access and visit:

```text
/api/admin/control/health
```

The response's `schemaCompatibility` field contains `{ ok, issues }`, with table
and requirement identifiers. Existing permission/authority configuration results
remain separate fields. Unauthorized callers cannot obtain this report.

Alternatively, in an environment with the existing `TURSO_CMS_DATABASE_URL` and
`TURSO_CMS_AUTH_TOKEN` configured, run from `HassCMS`:

```sh
npm run db:schema:live
```

The CLI reads metadata only, prints the full table compatibility result and exits
nonzero for drift or an unavailable check. Configure credentials through secrets;
do not paste them into commands or commit them. The CLI is a Node command, not
SQL for the Turso web editor.

The contract does not establish provider-secret validity, configured grants,
permission correctness, actual row validity, query cost, view definitions or audit
trigger-body equivalence. Those require their own checks. In particular, a pending
registration remaining isolated is verified by authentication integration tests;
a matching table shape alone cannot prove authorization behavior.

## Rollout

Merge and deploy CMS to enable the new readiness/report behavior. This change
does not execute any production DDL or alter customer data. If readiness identifies
drift, inspect the authorized report/server logs and use the relevant reviewed
migration. Do not suppress a failure by regenerating the contract from an
unreviewed live schema.
