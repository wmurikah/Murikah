-- Engineering Rhythm / Turso migration 009
-- Apply to the Engineering Turso database ONLY, after 008 and a verified backup.
-- Before running: SELECT id FROM schema_migrations ORDER BY id;
-- If 009 is recorded, STOP. Do not run this script again.
-- PRAGMA table_info(asset_movements); must show NO transfer_id before the ALTER.
-- This script deliberately does NOT change existing region/station codes or org_id.
-- Apply each statement successfully before recording schema_migrations 009.

CREATE TABLE IF NOT EXISTS asset_transfers (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_transfers_open
  ON asset_transfers(org_id, asset_id)
  WHERE status IN ('REQUESTED','APPROVED','DISPATCHED');

CREATE INDEX IF NOT EXISTS ix_asset_transfers_org_status
  ON asset_transfers(org_id, status, requested_at);

CREATE INDEX IF NOT EXISTS ix_asset_transfers_destination
  ON asset_transfers(org_id, to_station_id, status);

-- Execute only if PRAGMA table_info(asset_movements) showed no transfer_id:
ALTER TABLE asset_movements
  ADD COLUMN transfer_id TEXT REFERENCES asset_transfers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_asset_movements_transfer
  ON asset_movements(transfer_id);

INSERT OR IGNORE INTO permissions (key, module, description) VALUES
  ('assets.transfer.request', 'assets', 'Request a physical asset transfer'),
  ('assets.transfer.approve', 'assets', 'Approve an independent asset transfer'),
  ('assets.transfer.dispatch', 'assets', 'Confirm dispatch from the source station'),
  ('assets.transfer.receive', 'assets', 'Confirm receipt at the destination station');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.org_id IS NULL
   AND (
     (r.code IN ('OWNER','ADMIN','ENGINEERING_MANAGER')
       AND p.key IN ('assets.transfer.request','assets.transfer.approve','assets.transfer.dispatch','assets.transfer.receive'))
     OR (r.code = 'ENGINEER' AND p.key = 'assets.transfer.request')
     OR (r.code = 'STATION_MANAGER'
       AND p.key IN ('assets.transfer.request','assets.transfer.dispatch','assets.transfer.receive'))
   );

-- Record 009 only after all prior statements have succeeded:
INSERT INTO schema_migrations (id, description, checksum)
SELECT '009', 'Controlled asset transfers and affiliate-aware setup',
       '3fc6396763ad4f4956bf3fd2e98a7f3b991cab8f989ab1d8b63396d8b4df9bcf'
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '009');

-- Verify:
SELECT id, description, checksum FROM schema_migrations WHERE id = '009';
SELECT name FROM sqlite_schema
 WHERE name IN ('asset_transfers', 'ux_asset_transfers_open',
                'ix_asset_transfers_org_status',
                'ix_asset_transfers_destination', 'ix_asset_movements_transfer');
PRAGMA table_info(asset_movements);
SELECT r.code, p.key FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.key LIKE 'assets.transfer.%' ORDER BY r.code, p.key;
