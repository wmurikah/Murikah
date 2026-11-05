-- Run in Turso Web before migration 003.
-- One row means the column is missing and 04_apply_password_session_version.sql
-- must be run. No rows means stop: do not run ALTER TABLE a second time.
SELECT
  'users' AS table_name,
  'session_version' AS missing_column
WHERE NOT EXISTS (
  SELECT 1
  FROM pragma_table_info('users')
  WHERE name = 'session_version'
);
