import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

/**
 * Additive migration only. Region ownership already exists as regions.org_id;
 * affiliate selection is authorised through organisations.parent_org_id. Existing
 * human-entered station/region codes are never rewritten.
 */
export const controlledAssetTransfers: Migration = {
  id: '009',
  description: 'Controlled asset transfers and affiliate-aware setup',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS asset_transfers (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
      from_station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
      to_station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED','APPROVED','DISPATCHED','RECEIVED','REJECTED','CANCELLED')),
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      dispatched_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      received_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      approved_at TEXT,
      dispatched_at TEXT,
      received_at TEXT,
      resolved_at TEXT,
      expected_serial TEXT,
      dispatched_serial TEXT,
      received_serial TEXT,
      dispatch_condition TEXT,
      receipt_condition TEXT,
      dispatch_note TEXT,
      receipt_note TEXT,
      resolution_reason TEXT,
      CHECK (from_station_id <> to_station_id)
    )`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_transfers_open
      ON asset_transfers(org_id, asset_id)
      WHERE status IN ('REQUESTED','APPROVED','DISPATCHED')`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_asset_transfers_org_status
      ON asset_transfers(org_id, status, requested_at)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_asset_transfers_destination
      ON asset_transfers(org_id, to_station_id, status)`);

    const movementColumns = await db.execute('PRAGMA table_info(asset_movements)');
    if (!movementColumns.rows.some((r) => String(r.name) === 'transfer_id')) {
      await db.execute(`ALTER TABLE asset_movements
        ADD COLUMN transfer_id TEXT REFERENCES asset_transfers(id) ON DELETE SET NULL`);
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS ix_asset_movements_transfer
      ON asset_movements(transfer_id)`);

    const permissions = [
      ['assets.transfer.request', 'Request a physical asset transfer'],
      ['assets.transfer.approve', 'Approve an independent asset transfer'],
      ['assets.transfer.dispatch', 'Confirm dispatch from the source station'],
      ['assets.transfer.receive', 'Confirm receipt at the destination station'],
    ] as const;
    for (const [key, description] of permissions) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO permissions (key, module, description)
              VALUES (?, 'assets', ?)`,
        args: [key, description],
      });
    }
    // Deliberately do not assign approval powers to engineers or station
    // managers. Standard roles already exist after the 006 migration.
    for (const [role, keys] of [
      ['OWNER', permissions.map((p) => p[0])],
      ['ADMIN', permissions.map((p) => p[0])],
      ['ENGINEERING_MANAGER', permissions.map((p) => p[0])],
      ['ENGINEER', ['assets.transfer.request']],
      ['STATION_MANAGER', ['assets.transfer.request', 'assets.transfer.dispatch', 'assets.transfer.receive']],
    ] as const) {
      for (const key of keys) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
                SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
                 WHERE r.org_id IS NULL AND r.code = ? AND p.key = ?`,
          args: [role, key],
        });
      }
    }
  },
};
