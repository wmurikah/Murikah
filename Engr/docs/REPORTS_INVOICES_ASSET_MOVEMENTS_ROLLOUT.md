# Reports, contractor invoices, and asset movements

This release adds migration `008`. Apply it to Turso **before** deploying the new Worker. The old Worker is compatible with these additive tables and column. Back up the production database first.

## Turso Web steps

1. Open the Engineering production database in Turso Web. Run `SELECT id FROM schema_migrations ORDER BY id;`. Confirm migrations `001` through `007` are present. If `008` is already present, skip the remaining database steps.
2. Run `PRAGMA table_info(bills);`. If `invoice_required` is absent, run the first statement below once. Turso Web may show one result for each statement.
3. Run the table and index statements below. They use `IF NOT EXISTS` and are safe to repeat.
4. After every statement succeeds, insert the `008` history row. Do not record `008` before its objects exist.
5. Verify the final queries, then deploy the Worker build containing this change.

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

Only after those statements succeed:

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
