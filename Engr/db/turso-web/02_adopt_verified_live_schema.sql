-- Turso Web: run only after 01_verify_live_reconciliation.sql returns no rows.
-- This does not move or rewrite application data. It records that the already
-- compatible live schema has adopted the repository's immutable migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_migrations (id, description, checksum)
VALUES (
  '001',
  'Initial Engineering Rhythm schema',
  'af75dccac89cb0b6709f95b8f1ef277cb20e237d953452546f0a4c428ec2ff5f'
);

INSERT OR IGNORE INTO schema_migrations (id, description, checksum)
VALUES (
  '002',
  'Reconcile affiliate, platform owner, currency and versioned LPO schema',
  '80d02ddecbb406f3f892e36ef447ebeb175f70f71e34fa70cf0c61e96d7baaad'
);

SELECT id, description, checksum, applied_at
FROM schema_migrations
ORDER BY id;
