# CMS schema script register

**This project has no migration framework and is not getting one.** A schema
change is a numbered SQL file in this directory that the operator runs by hand
in the Turso console, without transaction keywords. That is the process, and
this file formalises it rather than replacing it.

Production must know which scripts have been applied. There is no table
recording that, deliberately: a table would itself need a script to create it,
and it would tell you what somebody claimed rather than what is true. Instead,
**every script ends with a verification query**, and `GET /api/health` runs a
subset of those same checks on every call, so the answer comes from the
database rather than from a record of intent.

## The register

| #   | Script                                                                           | What it does                                                                                                                                                                                                                                                                                                                   | Re-runnable                          | Reversible                                                            | How to verify                                             |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| 0   | `hass_cms_turso_v1_FINAL.sql` (not in this directory)                            | The v2 baseline: every table, index and constraint, plus the demo seed                                                                                                                                                                                                                                                         | **No**                               | No                                                                    | `SELECT COUNT(*) FROM sqlite_master WHERE type='table'`   |
| 1   | `organisation/01_add_organisation_permissions.sql`                               | Organisation permission codes and grants                                                                                                                                                                                                                                                                                       | Yes                                  | Yes, delete the rows                                                  | The script's own `SELECT` returns the codes               |
| 2   | `customers/02_add_customer_permissions.sql`                                      | Customer permission codes and grants                                                                                                                                                                                                                                                                                           | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 3   | `crm/03_add_lead_permissions.sql`                                                | Lead MANAGE and lead-source codes                                                                                                                                                                                                                                                                                              | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 4   | `crm/04_add_opportunity_permissions.sql`                                         | Opportunity codes                                                                                                                                                                                                                                                                                                              | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 5   | `service/05_add_service_permissions.sql`                                         | Service codes                                                                                                                                                                                                                                                                                                                  | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 6   | `data/06_add_import_grants.sql`                                                  | Grants the finance roles the two upload codes                                                                                                                                                                                                                                                                                  | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 7   | `portal/07_portal_prerequisites.sql`                                             | `entity_attachments.customer_visible`, `portal_document_title`, `survey_invitations`                                                                                                                                                                                                                                           | **The two ALTERs are not**           | **No**                                                                | Its own three-row `SELECT`; also in `/api/health`         |
| 8   | `audit/08_audit_immutability.sql`                                                | Two triggers making `audit_events` append-only                                                                                                                                                                                                                                                                                 | Yes                                  | **No, in practice**                                                   | Its own `SELECT`; also in `/api/health`                   |
| 9   | `audit/09_add_audit_permissions.sql`                                             | `AUDIT.EVENTS.SECURITY_VIEW` and `AUDIT.EVENTS.EXPORT`                                                                                                                                                                                                                                                                         | Yes                                  | Yes                                                                   | Its own `SELECT`                                          |
| 10  | `assistant/10_assistant_and_channels.sql` (**not in this directory**, see below) | The six assistant and channel tables: `ai_providers`, `bot_conversations`, `bot_messages`, `channel_connections`, `channel_messages`, `message_classifications`                                                                                                                                                                | Yes, if written with `IF NOT EXISTS` | **No**, dropping them loses every recorded message and classification | `/api/health` counts all six in `sqlite_master`           |
| 12  | `permissions/12_reconcile_permission_catalogue.sql`                              | **Every one of the 38 codes the application checks, with ids derived from the code so two cannot collide.** A superset of scripts 1-9's permission rows; grants all 38 to `ROLE-ADMIN`, plus the customer codes to Sales, Credit, Customer Service and Finance and the new `CUSTOMERS.CREDIT_TERMS.VIEW` to Credit and Finance | Yes                                  | Yes, delete the rows                                                  | Its own `SELECT` (a) returns NO rows, and (d) returns 44  |
| —   | `executive/08_add_executive_permission.sql`                                      | **NUMBER AND ID COLLISION, see below.** `EXECUTIVE.DASHBOARD.VIEW`, so a holder lands on the executive dashboard at sign-in                                                                                                                                                                                                    | Yes                                  | Yes                                                                   | Its own two `SELECT`s                                     |
| —   | `SO/PO source completeness rebuild` (run before phase 17)                        | Makes the commercial columns on the four order tables nullable                                                                                                                                                                                                                                                                 | **No**                               | No                                                                    | `/api/health` checks `purchase_order_lines.unit_cost`     |
| —   | `production/10_production_cleanup.sql`                                           | **Removes the demo seed. Never run without review.**                                                                                                                                                                                                                                                                           | No                                   | **No**                                                                | See the script                                            |
| —   | `production/11_validation_cleanup.sql`                                           | **Removes the phase 30 validation dataset.** Only needed if the journeys were replayed by hand                                                                                                                                                                                                                                 | No                                   | **No**                                                                | Its own step 9, every count zero                          |
| —   | `PHASE4_LIVE_RECONCILIATION.sql`                                                 | Reconciles verified live Phase 4 request columns and adds atomic OIDC transactions                                                                                                                                                                                                                                             | **No**                               | Forward fix only                                                      | `PHASE4_LIVE_VERIFICATION.sql`                            |
| —   | `PHASE4_LIVE_VERIFICATION.sql`                                                   | Read-only DDL, index, foreign-key, count, policy, uniqueness and integrity evidence                                                                                                                                                                                                                                            | Yes                                  | Not applicable, it changes nothing                                    | The script is the verification block                      |
| —   | `teardown/00_inventory.sql`                                                      | Read-only. Counts every table before a teardown, so an operator sees what they are about to lose                                                                                                                                                                                                                               | Yes                                  | Not applicable, it changes nothing                                    | It is itself a `SELECT`                                   |
| —   | `teardown/02_drop_all.sql`                                                       | **Drops every CMS table.** For rebuilding a development database, never production                                                                                                                                                                                                                                             | Yes                                  | **No**                                                                | `SELECT COUNT(*) FROM sqlite_master` returns 0 CMS tables |

## The PERM-041 collision, and how script 12 resolves it

`audit/09_add_audit_permissions.sql` inserts `PERM-041` as
`AUDIT.EVENTS.SECURITY_VIEW`. `executive/08_add_executive_permission.sql`
inserts `PERM-041` as `EXECUTIVE.DASHBOARD.VIEW`. They are different codes with
the same primary key.

Both statements are `INSERT OR IGNORE`, so **whichever script runs second is
silently discarded**. No error, no warning, and the losing code is absent for
ever. Worse, both scripts then grant `PERM-041` to `ROLE-ADMIN`, and that grant
succeeds — pointing at the other script's permission. The catalogue looks
populated, `role_permissions` looks correct, and one of the two codes can never
be held by anybody.

That is the class of fault a hand-assigned identifier invites, and renumbering
one of the two scripts would only fix this instance.

`permissions/12_reconcile_permission_catalogue.sql` fixes the class:

1. **Every `permission_id` is derived from its code**
   (`PERM-CUSTOMERS-ACCOUNTS-VIEW`), so two different codes cannot claim one id.
2. **Grants look their permission up BY CODE**, not by id, so a code that
   already exists under an older hand-assigned id is granted under that id
   rather than skipped.
3. It is a **superset of scripts 1 to 9's permission rows**, so running it is
   sufficient on its own, in any order, before or after them, and twice.

`test/cms/permissionCatalogue.test.ts` runs the file verbatim against a
database seeded with the same 28 rows as the live one and asserts that both
codes survive.

## Script 10 is applied and its file is not here

The operator ran it against the live database on 30 August 2026 and confirmed
all six tables by query. The file itself was never committed, which is the gap
this row exists to close: the register is meant to answer "what has been run",
and for a while the honest answer to "do these tables exist" was only
obtainable by asking production.

Two consequences, both deliberate:

1. **`/api/health` now counts them.** It reports the group as applied only when
   all six are present, because a script that created four and stopped leaves
   an application that can configure a provider and then cannot record a
   single message. A half-run script must not read as a healthy one.
2. **`test/cms/support/schema.ts` mirrors them**, so the next phase discovers a
   missing table by running the suite rather than by shipping code against a
   table that is not there. That mirror is copied from the live DDL rather than
   written from the application's expectations, which is the only direction
   that catches a disagreement.

If the file is recovered, add it to `assistant/` under this number and delete
this section.

## Rules

1. **Run them in order.** A permission grant references a role the baseline
   created; a portal query references a column script 7 added.
2. **No transaction keywords.** The Turso console runs statements one at a
   time and a `BEGIN` left open is worse than a script half-applied.
3. **Read the top of the file first.** Scripts 7, 8, 10 and 11 each have a
   consequence stated there that is not obvious from the SQL.
4. **Never run `hass_cms_turso_v1_FINAL.sql` against a live database.** It
   recreates the demo seed. There is no guard preventing it; the only control
   is that somebody read this line.

## What is not trivially reversible, and why

- **Script 7's `ALTER TABLE ... ADD COLUMN`.** SQLite cannot drop a column
  without rebuilding the table, which on a live database means copying every
  attachment row. The forward fix for a mistake here is another `ALTER`, not
  a rollback.
- **Script 8's triggers.** `DROP TRIGGER` is one statement, so it is
  reversible mechanically. In practice it is not: dropping them is removing
  the control that makes the audit trail evidence, and doing it would itself
  be the thing an auditor asks about. Treat it as one-way.
- **The SO/PO source completeness rebuild.** It rebuilds four tables to widen
  their NOT NULL constraints. Narrowing them again would fail on any row
  written since.
- **The baseline.** Obviously.

## Applying to a new environment

```
1. hass_cms_turso_v1_FINAL.sql          (creates everything, seeds the demo)
2. the SO/PO source completeness rebuild
3. docs/cms/organisation/01 ... docs/cms/executive/08, in number order
4. GET /api/health                       (expect status "ok")
5. production/10_production_cleanup.sql  (production only, after review)
6. pnpm db:cms:bootstrap-admin           (creates the first real administrator)
```

Step 4 before step 5 is deliberate: verify the schema is complete while the
demo data is still there to verify it against.

## An unresolved collision: `executive/08_add_executive_permission.sql`

This script was written while the audit scripts were in flight, and neither
saw the other. It collides with them twice:

- **File number.** It is numbered `08`, and so is `audit/08_audit_immutability.sql`.
- **Permission id.** It claims `PERM-041`, and so does
  `audit/09_add_audit_permissions.sql`, for `AUDIT.EVENTS.SECURITY_VIEW`.

Both scripts use `INSERT OR IGNORE`, so **whichever runs second inserts nothing
and reports nothing**. One of the two permissions would simply never exist, and
the only symptom would be a person who cannot see a screen they were granted.

WHICH ONE MOVES DEPENDS ON WHAT HAS ALREADY BEEN RUN, which is a fact about the
live database rather than about this repository, so it is not decided here. If
neither has been run, renumbering the executive script to `12` and its code to
`PERM-042` is the smaller change: the audit scripts are referenced by
`/api/health` and by the audit tests, and the executive one is referenced by
nothing but itself.
