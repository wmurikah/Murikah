import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

export const invoicesAndAssetMovements: Migration = {
  id: '008',
  description: 'Contractor invoices and auditable asset transfers',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    const billColumns = await db.execute('PRAGMA table_info(bills)');
    if (!billColumns.rows.some((row) => String(row.name) === 'invoice_required')) {
      await db.execute(`ALTER TABLE bills ADD COLUMN invoice_required INTEGER NOT NULL DEFAULT 0
        CHECK (invoice_required IN (0,1))`);
    }
    await db.execute(`CREATE TABLE IF NOT EXISTS supplier_invoices (
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
    )`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_invoice_number_folded
      ON supplier_invoices(org_id, contractor_id, lower(trim(invoice_no)))`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_supplier_invoices_org_due
      ON supplier_invoices(org_id, due_date)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_supplier_invoices_org_created
      ON supplier_invoices(org_id, created_at)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS asset_movements (
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
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_asset_movements_asset_time
      ON asset_movements(org_id, asset_id, moved_at)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_asset_movements_org_time
      ON asset_movements(org_id, moved_at)`);
  },
};
