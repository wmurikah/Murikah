# Signed SLA target rollout

This rollout applies the targets in the signed **Interdepartmental Service
Level Agreement** without claiming measurements the current extracts cannot
support.

## Applied targets

| CMS function                   | Signed target | System treatment              |
| ------------------------------ | ------------: | ----------------------------- |
| Sales order Finance approval   |    15 minutes | Active; warning at 10 minutes |
| Sales order Credit approval    |    15 minutes | Active; warning at 10 minutes |
| Purchase order approval level  |    30 minutes | Active; warning at 25 minutes |
| Customer Service LA generation |    10 minutes | Stored but inactive           |

The warning thresholds are internal alerts five minutes before the target.
They are not additional contractual terms.

The LA-generation rule remains inactive because the signed clock begins when
funds or an LPO are received. The current Sales Order extract records the LA
timestamp but does not record that receipt timestamp. The existing
order-created-to-LA measure remains available as operational elapsed time, but
the CMS does not present it as compliance with the signed 10-minute promise.

The signed document also contains Treasury confirmation, Shared Services
posting, PO-raising, loading, distribution and IT targets. They require their
own start and completion events or process classification. This migration does
not invent those events from unrelated timestamps.

## Turso web rollout

1. Open the `hass-cms` database in Turso.
2. Run the complete contents of
   `db/migrations/007_signed_sla_targets.sql` as one script. Do not add
   `BEGIN`, `COMMIT` or `END`; Drizzle Studio automatically runs the statements
   as one transaction and rejects transaction keywords inside the script.
3. Confirm the final query returns these four rows:

| Rule         | Target | Warning | Active |
| ------------ | -----: | ------: | -----: |
| `SLAR-003`   |     15 |      10 |      1 |
| `SLAR-004`   |     15 |      10 |      1 |
| `SLAR-SO-LA` |     10 |       5 |      0 |
| `SLAR-PO-30` |     30 |      25 |      1 |

4. Redeploy `hass-cms` after merging the application change.
5. Open Home and verify Finance and Credit show 15-minute targets. Loading
   Authority must show that its contractual target cannot yet be assessed.

The migration is idempotent and does not delete or rewrite orders, imports,
workflow events, SLA instances or breach history.
