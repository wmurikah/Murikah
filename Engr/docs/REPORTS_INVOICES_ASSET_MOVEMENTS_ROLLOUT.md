# Reports, contractor invoices, and asset movements

This release adds migration `008`. Apply it to Turso **before** deploying the new Worker. The old Worker is compatible with these additive tables and column. Back up the production database first.

## Turso Web steps

1. Open the Engineering production database in Turso Web. Run `SELECT id FROM schema_migrations ORDER BY id;`. If `007` is missing but `001` through `006` are present, apply the `007` recovery block below first. If `008` is already present, skip its database steps.
2. Run `PRAGMA table_info(bills);`. If `invoice_required` is absent, run the first statement below once. Turso Web may show one result for each statement.
3. Run each table and index statement below **separately** in Turso Web, checking its result before moving to the next. A generic `OK` from a pasted multi-statement block does not prove every statement was executed. They use `IF NOT EXISTS` and are safe to repeat.
4. After every statement succeeds, insert the `008` history row. Do not record `008` before its objects exist.
5. Verify the final queries, then deploy the Worker build containing this change. Open `/api/health` and confirm `reportingSchema` reads `ok`.

### If migration 007 is missing

These four indexes are additive and safe to create again. Run them before recording the migration history row:

```sql
CREATE INDEX IF NOT EXISTS ix_notifications_queue_created
  ON notifications(created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS ix_notifications_unread
  ON notifications(org_id, channel, status, recipient_user_id);
CREATE INDEX IF NOT EXISTS ix_requests_org_created_active
  ON service_requests(org_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_pm_occ_org_due
  ON pm_occurrences(org_id, due_date);
```

Confirm the count is `4`:

```sql
SELECT COUNT(*) AS indexes_created FROM sqlite_schema
WHERE type = 'index' AND name IN (
  'ix_notifications_queue_created',
  'ix_notifications_unread',
  'ix_requests_org_created_active',
  'ix_pm_occ_org_due'
);
```

Then record `007` once:

```sql
INSERT INTO schema_migrations (id, description, checksum)
SELECT '007', 'Index notification delivery and organisation dashboard queries',
       'b2ccf1719a8d3f7ce9ed9d5e3eda1bc9ad910d4744703bd4713ec544e6363033'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '007');
```

Return to the `008` steps below. Do not re-run the table/index block if it already succeeded; only check the bill column and verify the objects.

```sql
ALTER TABLE bills ADD COLUMN invoice_required INTEGER NOT NULL DEFAULT 0 CHECK (invoice_required IN (0,1));
```

```sql
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  bill_id TEXT NOT NULL UNIQUE REFERENCES bills(id) ON DELETE RESTRICT,
  invoice_no TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  tax_reference TEXT,
  notes TEXT,
  original_name TEXT,
  original_pdf BLOB,
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, contractor_id, invoice_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_invoice_number_folded
  ON supplier_invoices(org_id, contractor_id, lower(trim(invoice_no)));
CREATE INDEX IF NOT EXISTS ix_supplier_invoices_org_due
  ON supplier_invoices(org_id, due_date);
CREATE INDEX IF NOT EXISTS ix_supplier_invoices_org_created
  ON supplier_invoices(org_id, created_at);

CREATE TABLE IF NOT EXISTS asset_movements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  from_station_name TEXT,
  from_region_id TEXT REFERENCES regions(id) ON DELETE SET NULL,
  from_region_name TEXT,
  to_station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  to_station_name TEXT NOT NULL,
  to_region_id TEXT REFERENCES regions(id) ON DELETE SET NULL,
  to_region_name TEXT,
  reason TEXT,
  moved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  moved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_asset_movements_asset_time
  ON asset_movements(org_id, asset_id, moved_at);
CREATE INDEX IF NOT EXISTS ix_asset_movements_org_time
  ON asset_movements(org_id, moved_at);
```

Before recording `008`, confirm this returns `1` for `bill_column`, `2` for `tables_created`, and `5` for `indexes_created`:

```sql
SELECT
  (SELECT COUNT(*) FROM pragma_table_info('bills')
    WHERE name = 'invoice_required') AS bill_column,
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name IN ('supplier_invoices', 'asset_movements')) AS tables_created,
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'index' AND name IN (
      'ux_supplier_invoice_number_folded',
      'ix_supplier_invoices_org_due',
      'ix_supplier_invoices_org_created',
      'ix_asset_movements_asset_time',
      'ix_asset_movements_org_time'
    )) AS indexes_created;
```

Only after those counts match:

```sql
INSERT INTO schema_migrations (id, description, checksum)
SELECT '008', 'Contractor invoices and auditable asset transfers',
       '64b0a6c5524ab592896c9cdcdb0680cb268fe6358b5933d4b94884a5a97d0af1'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '008');
```

Verify:

```sql
SELECT id, description, checksum FROM schema_migrations WHERE id = '008';
SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('supplier_invoices', 'asset_movements');
PRAGMA table_info(bills);
```

## First-use checks

1. Sign in as a contractor. Create a bill, attach approved costs, then record the contractor invoice number, issue/due dates, and original PDF. The invoice must be present before a **new** bill can be submitted. Bills created before this migration remain on their existing workflow.
2. Open **Finance → Invoices** as a manager or Financial Controller. Confirm the invoice, outstanding amount, and original download are visible. Contractor accounts see only their own invoices.
3. Open an asset in **Setup → Assets**. Change its station, enter a transfer reason, and save. Check **Location history** for the old and new station and region. Existing assets have no inferred historical movements; tracking starts when they are next moved.
4. Open **Reports → Report centre**. Check the asset movements, bill, invoice, operations, procurement and maintenance reports. Excel, Word, PDF, SVG and CSV exports are available to users with `reports.export` and the underlying record permission. Exports are capped at 500 rows; narrow the date range for larger sets.

Original invoice PDFs are stored in Turso and limited to 2 MB each. Monitor database storage as invoice volume grows; move originals to private object storage with authenticated downloads when the pilot expands.
