-- Expected before migration 004: three rows. If no rows are returned, inspect
-- schema_migrations before applying anything again.
WITH required(name) AS (
  VALUES ('auth_tokens'), ('user_mfa'), ('mfa_recovery_codes')
)
SELECT required.name AS missing_table
FROM required
LEFT JOIN sqlite_schema
  ON sqlite_schema.type = 'table' AND sqlite_schema.name = required.name
WHERE sqlite_schema.name IS NULL
ORDER BY required.name;
