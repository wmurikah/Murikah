-- Run once in Turso Web only when 03_check_password_session_version.sql returns
-- the missing session_version row. Drizzle Studio batches these statements in
-- one transaction; do not add BEGIN or COMMIT.
ALTER TABLE users
ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (id, description, checksum)
VALUES (
  '003',
  'Add password session generation for immediate session revocation',
  '009f6cb898d1210fc34bcfc4c575cc69a6b9b01f9f56503aa765267ebf0f42e8'
);

SELECT id, description, checksum, applied_at
FROM schema_migrations
ORDER BY id;
