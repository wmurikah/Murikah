# Engineering role and approval rollout

This rollout applies the reviewed organisation roles, record scopes and maker/checker workflows.
Run it against Turso before deploying application code that contains migration `006`.

## Role contract

| Role                 | Record scope                  | Main responsibilities                                                                  | Approval authority                                                                                                      |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Owner                | Organisation                  | Full organisation control, security and operations                                     | All organisation approvals                                                                                              |
| Administrator        | Organisation                  | Full administration and operations; cannot grant Owner                                 | All organisation approvals                                                                                              |
| Engineering Manager  | Organisation                  | Operational users, setup, routing, requests, RFQs, maintenance, LPOs and work orders   | Request acceptance, RFQ release/award, PM activation/allocation, LPO approval/issue, cost and Engineering bill approval |
| Engineer             | Organisation                  | Create and populate requests, RFQs, maintenance schedules, LPOs and work-order drafts  | None                                                                                                                    |
| Station Manager      | Assigned stations             | Raise requests, view station work, confirm arrival and closure                         | Station arrival and completed-work confirmation                                                                         |
| Financial Controller | Organisation finance          | View approved costs and bills, record/reverse payments, export finance reports         | Final Finance bill approval                                                                                             |
| Contractor           | Linked contractor             | Submit quotes, accept assigned work, manage linked technicians, submit costs and bills | None                                                                                                                    |
| Technician           | Linked technician assignments | Accept/start assigned work, submit JSA and job cards                                   | None                                                                                                                    |
| Viewer               | Organisation operational read | Read operational dashboards and records                                                | None                                                                                                                    |

Internal organisation roles take precedence if an account accidentally holds both an internal role and a portal role. Contractor and technician actions still require the database link from the user to that contractor or technician. Station actions require the user to be the station's assigned manager.

The Engineering Manager may assign operational roles only: Engineer, Station Manager, Contractor, Technician and Viewer. An Administrator may assign every role except Owner and cannot alter the Owner role contract. An Owner or platform owner may assign any role. Standard role codes are reserved; custom roles use separate codes and are preserved.

## Maker/checker controls

- An engineer raises a request; a different authorised user accepts or rejects it.
- An engineer builds and submits an RFQ; a different authorised user releases it to contractors.
- An engineer creates a preventive-maintenance schedule in `PAUSED`; a different authorised user activates it.
- An engineer creates and submits an LPO draft; a different authorised user approves it before it can be issued.
- A direct work order remains `CREATED` until a different authorised user assigns it to the contractor.
- A contractor submits a cost; Engineering approves it.
- A contractor submits a bill; Engineering approves first and Finance approves finally.

Every action is permission checked on the server, organisation scoped, state guarded and audited. Portal reads are also restricted by station, contractor or technician ownership.

## Turso Web sequence

1. Open the production database in Turso/Drizzle Studio.
2. Run `db/turso-web/13_check_comprehensive_rbac.sql`.
3. Do not continue if any duplicate portal-user or engineer-routing query returns a row. Correct those duplicate links first.
4. Confirm that migration `006` is absent and all nine listed workflow columns are reported as missing. Script `14` is a one-time upgrade and must not be run after those columns already exist.
5. Run `db/turso-web/14_apply_comprehensive_rbac.sql` once. Drizzle Studio supplies the transaction; do not add `BEGIN` or `COMMIT`.
6. Run script `13` again. The missing column, wrong checksum, duplicate, missing index, retired permission, missing grant and unexpected grant queries must return zero rows. The final count queries are informational.
7. Deploy the Worker/application revision.
8. Sign in again. Resetting role grants revokes existing sessions by design.

The application migration and clean-install seed are generated from the same role contract as the Turso scripts. Regenerate them after any deliberate role change with:

```sh
node --experimental-strip-types db/generate-rbac-sql.ts
node --experimental-strip-types db/generate-schema.ts
```

## Login deployment requirement

Set `ENGR_MFA_ENCRYPTION_KEY` as an encrypted Cloudflare Worker variable before testing Owner or Administrator sign-in. Use exactly 32 random bytes encoded as Base64, for example:

```sh
openssl rand -base64 32
```

The base login route no longer crashes when the key is absent, but mandatory privileged-account MFA cannot operate until the key is configured. The health endpoint reports the missing MFA configuration.
