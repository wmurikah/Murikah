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

| #   | Script                                                    | What it does                                                                                                                | Re-runnable                | Reversible                         | How to verify                                             |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------- | --------------------------------------------------------- |
| 0   | `hass_cms_turso_v1_FINAL.sql` (not in this directory)     | The v2 baseline: every table, index and constraint, plus the demo seed                                                      | **No**                     | No                                 | `SELECT COUNT(*) FROM sqlite_master WHERE type='table'`   |
| 1   | `organisation/01_add_organisation_permissions.sql`        | Organisation permission codes and grants                                                                                    | Yes                        | Yes, delete the rows               | The script's own `SELECT` returns the codes               |
| 2   | `customers/02_add_customer_permissions.sql`               | Customer permission codes and grants                                                                                        | Yes                        | Yes                                | Its own `SELECT`                                          |
| 3   | `crm/03_add_lead_permissions.sql`                         | Lead MANAGE and lead-source codes                                                                                           | Yes                        | Yes                                | Its own `SELECT`                                          |
| 4   | `crm/04_add_opportunity_permissions.sql`                  | Opportunity codes                                                                                                           | Yes                        | Yes                                | Its own `SELECT`                                          |
| 5   | `service/05_add_service_permissions.sql`                  | Service codes                                                                                                               | Yes                        | Yes                                | Its own `SELECT`                                          |
| 6   | `data/06_add_import_grants.sql`                           | Grants the finance roles the two upload codes                                                                               | Yes                        | Yes                                | Its own `SELECT`                                          |
| 7   | `portal/07_portal_prerequisites.sql`                      | `entity_attachments.customer_visible`, `portal_document_title`, `survey_invitations`                                        | **The two ALTERs are not** | **No**                             | Its own three-row `SELECT`; also in `/api/health`         |
| 8   | `audit/08_audit_immutability.sql`                         | Two triggers making `audit_events` append-only                                                                              | Yes                        | **No, in practice**                | Its own `SELECT`; also in `/api/health`                   |
| 9   | `audit/09_add_audit_permissions.sql`                      | `AUDIT.EVENTS.SECURITY_VIEW` and `AUDIT.EVENTS.EXPORT`                                                                      | Yes                        | Yes                                | Its own `SELECT`                                          |
| —   | `executive/08_add_executive_permission.sql`               | **NUMBER AND ID COLLISION, see below.** `EXECUTIVE.DASHBOARD.VIEW`, so a holder lands on the executive dashboard at sign-in | Yes                        | Yes                                | Its own two `SELECT`s                                     |
| —   | `SO/PO source completeness rebuild` (run before phase 17) | Makes the commercial columns on the four order tables nullable                                                              | **No**                     | No                                 | `/api/health` checks `purchase_order_lines.unit_cost`     |
| —   | `production/10_production_cleanup.sql`                    | **Removes the demo seed. Never run without review.**                                                                        | No                         | **No**                             | See the script                                            |
| —   | `production/11_validation_cleanup.sql`                    | **Removes the phase 30 validation dataset.** Only needed if the journeys were replayed by hand                              | No                         | **No**                             | Its own step 9, every count zero                          |
| —   | `PHASE4_LIVE_RECONCILIATION.sql`                          | Reconciles verified live Phase 4 request columns and adds atomic OIDC transactions                                          | **No**                     | Forward fix only                   | `PHASE4_LIVE_VERIFICATION.sql`                            |
| —   | `PHASE4_LIVE_VERIFICATION.sql`                            | Read-only DDL, index, foreign-key, count, policy, uniqueness and integrity evidence                                         | Yes                        | Not applicable, it changes nothing | The script is the verification block                      |
| —   | `teardown/00_inventory.sql`                               | Read-only. Counts every table before a teardown, so an operator sees what they are about to lose                            | Yes                        | Not applicable, it changes nothing | It is itself a `SELECT`                                   |
| —   | `teardown/02_drop_all.sql`                                | **Drops every CMS table.** For rebuilding a development database, never production                                          | Yes                        | **No**                             | `SELECT COUNT(*) FROM sqlite_master` returns 0 CMS tables |

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
3. docs/cms/organisation/01 ... docs/cms/audit/09, in number order
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
