-- Turso Web: run this read-only query before adopting migration history.
-- Expected result for the audited live database: no rows.
WITH required(kind, parent_name, object_name) AS (
  VALUES
    ('table', '', 'lpo_lines'),
    ('column', 'organisations', 'parent_org_id'),
    ('column', 'regions', 'currency'),
    ('column', 'users', 'is_platform_owner'),
    ('column', 'lpos', 'region_id'),
    ('column', 'lpos', 'notes'),
    ('column', 'lpos', 'subtotal_minor'),
    ('column', 'lpos', 'mileage_minor'),
    ('column', 'lpos', 'approved_by'),
    ('column', 'lpos', 'approved_at'),
    ('column', 'lpos', 'issued_by'),
    ('column', 'lpos', 'issued_at'),
    ('column', 'lpos', 'sealed_hash'),
    ('column', 'lpos', 'sealed_at'),
    ('column', 'lpos', 'version'),
    ('column', 'lpos', 'supersedes_id'),
    ('column', 'lpos', 'superseded_by_id'),
    ('column', 'lpos', 'cancelled_at'),
    ('column', 'lpos', 'cancel_reason'),
    ('index', '', 'ix_lpo_lines_lpo'),
    ('index', '', 'ix_lpos_region'),
    ('index', '', 'ix_org_parent'),
    ('index', '', 'ux_roles_system'),
    ('index', '', 'ux_users_email')
),
present(kind, parent_name, object_name) AS (
  SELECT type, '', name
  FROM sqlite_schema
  WHERE type IN ('table', 'index')
  UNION ALL
  SELECT 'column', 'organisations', name FROM pragma_table_info('organisations')
  UNION ALL
  SELECT 'column', 'regions', name FROM pragma_table_info('regions')
  UNION ALL
  SELECT 'column', 'users', name FROM pragma_table_info('users')
  UNION ALL
  SELECT 'column', 'lpos', name FROM pragma_table_info('lpos')
)
SELECT
  required.kind AS missing_kind,
  required.parent_name AS table_name,
  required.object_name AS missing_name
FROM required
LEFT JOIN present
  ON present.kind = required.kind
 AND present.parent_name = required.parent_name
 AND present.object_name = required.object_name
WHERE present.object_name IS NULL
ORDER BY required.kind, required.parent_name, required.object_name;
