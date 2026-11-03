# Remove eight redundant explicit indexes

Migration `db/migrations/005_remove_redundant_indexes.mjs` removes only the eight
audited explicit indexes. It leaves their equivalent UNIQUE constraint indexes,
all other indexes, constraints and application rows intact. This reduces index
maintenance on future writes. Actual storage/billing savings depend on live data;
dropped SQLite pages can be reused without immediately shrinking the database
file. This migration does not run VACUUM or rebuild tables.

| Table                 | Explicit index removed     | UNIQUE key retained                |
| --------------------- | -------------------------- | ---------------------------------- |
| business_units        | idx_business_units_code    | business_unit_code                 |
| users                 | idx_users_email            | email (NOCASE)                     |
| accounts              | idx_accounts_oracle_code   | oracle_customer_code               |
| record_snapshots      | idx_snapshots_entity       | entity_type, entity_id, version_no |
| sla_escalation_events | ix_sla_escalation_instance | sla_instance_id, escalation_level  |
| so_extract_rows       | ix_so_extract_batch        | import_batch_id, source_row_number |
| po_extract_rows       | ix_po_extract_batch        | import_batch_id, source_row_number |
| bot_messages          | ix_bot_msg_conv            | bot_conversation_id, sequence_no   |

## Run from an environment with database access

This is a Node runner, **not SQL to paste into Turso's data console**. A runner
lets checks and DDL share one libSQL write transaction: it refuses unexpected
definitions before any drop and rolls back all drops on failure. A sequence of
manually pasted DROP statements cannot provide the same conditional safeguards.
Use Node 22+ and the existing HassCMS dependencies. Configure
`TURSO_CMS_DATABASE_URL` and `TURSO_CMS_AUTH_TOKEN` through the execution
environment's variables/secrets. Do not commit credentials or paste them into
the commands below.

1. Check external jobs, DBA tools and reports for `INDEXED BY` or other references
   to the eight explicit names. A repository-wide search found only two historical
   test-fixture definitions and no forced-index queries. External tooling remains
   unverified; the runner also rejects stored views/triggers that may force a name.
2. Run `db/diagnostics/redundant_index_plans.sql` in Turso before cleanup. These
   compile full-key and composite-prefix lookup probes without reading customer
   rows. Also compare EXPLAIN plans for your important production queries, since
   these probes cannot represent every workload or current planner statistic.
3. From the repository root, preview the current live definitions:

   ```sh
   cd HassCMS
   node db/migrations/005_remove_redundant_indexes.mjs
   ```

   Expect eight `WOULD_REMOVE` results (or `ALREADY_ABSENT` after an earlier
   cleanup), each naming the retained UNIQUE index. Preview reads schema metadata
   only. It does not scan/count application tables or change indexes.

4. After reviewing the preview and plans, apply:

   ```sh
   node db/migrations/005_remove_redundant_indexes.mjs --apply
   ```

   Expect eight `REMOVED`/`ALREADY_ABSENT` results. All candidates are checked
   within the transaction before the first drop. Checks include the expected
   table, exact ordered columns, collation, ascending direction, absence of
   expressions/partial predicates, non-unique explicit origin, and a matching
   full UNIQUE constraint index. The email pair uses NOCASE; other pairs use
   BINARY. A unique index added outside a table constraint is insufficient.
   Any mismatch aborts the cleanup; inspect it rather than weakening the checks.

5. Rerun preview: expect all eight `ALREADY_ABSENT` with retained UNIQUE indexes.
   Repeat the plan probes in a separate console/session and compare production
   query plans, request timings and Turso read/write/storage metrics over similar
   workload windows. The UNIQUE indexes continue supporting full-key lookups and
   left-prefix searches, but live performance remains a measurement task.

An interrupted connection can leave the commit outcome uncertain. Preview again
before retrying; the operation is rerunnable. Apply briefly takes a schema/write
lock, so use a low-activity period. It does not require migration 004, an application
deploy or any change to the application queries. Merging the PR does not run it.

If a live workload requires an explicit name again, review and run
`db/diagnostics/redundant_index_restore.sql`; it recreates the exported definitions
and adds storage/write overhead back. Inspect any existing name conflict first.

## Validation and limits

`node test/cms/redundantIndexes.test.mjs` uses the actual libSQL client with a local
database and the eight tables' exported definitions. With 200 synthetic rows per
table it checks preview behavior, unchanged data and unrelated schema objects,
retained uniqueness (including case-insensitive email and nullable keys), full-key
and composite-prefix plans, safe reruns, definition drift, stored forced-index
references and transaction rollback. The focused fixture omits FK parent tables
and disables FK enforcement for seeding; no production data is included.

Live counts, write rates, external tools and production performance have not been
inspected from this environment. Local equivalence proves redundancy of these
definitions; it does not quantify a bill reduction or justify dropping other
indexes merely because they share a leading column.
