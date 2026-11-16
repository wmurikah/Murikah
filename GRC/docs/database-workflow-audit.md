# GRC database and workflow audit

These queries are read-only. Run them in the Turso Web shell for `hassaudit`
and export each result as JSON. They describe the live database; do not paste
database credentials, password hashes, tokens, notification bodies or sealed
configuration values into an audit report.

The repository's current expected column dictionary is `GRC/db/schema.md`.
Compare the live output below with that file and with
`GRC/docs/schema-assumptions.md`; the live database is authoritative.

## 1. Complete object and DDL inventory

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY CASE type
  WHEN 'table' THEN 1
  WHEN 'index' THEN 2
  WHEN 'view' THEN 3
  WHEN 'trigger' THEN 4
  ELSE 5
END, name;
```

This is the most complete single schema export: tables, indexes, views,
triggers and their creation SQL.

## 2. Every table and column

```sql
SELECT m.name AS table_name,
       p.cid AS column_position,
       p.name AS column_name,
       p.type AS declared_type,
       p."notnull" AS is_not_null,
       p.dflt_value AS default_value,
       p.pk AS primary_key_position,
       p.hidden AS hidden_column
FROM sqlite_schema AS m
JOIN pragma_table_xinfo(m.name) AS p
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, p.cid;
```

## 3. Foreign-key relationships

```sql
SELECT m.name AS child_table,
       fk.id AS relationship_id,
       fk.seq AS column_position,
       fk."from" AS child_column,
       fk."table" AS parent_table,
       fk."to" AS parent_column,
       fk.on_update,
       fk.on_delete,
       fk.match
FROM sqlite_schema AS m
JOIN pragma_foreign_key_list(m.name) AS fk
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, fk.id, fk.seq;
```

Also run SQLite's live integrity check:

```sql
PRAGMA foreign_key_check;
```

An empty result is the desired result.

## 4. Index coverage

```sql
SELECT m.name AS table_name,
       il.name AS index_name,
       il."unique" AS is_unique,
       il.origin AS index_origin,
       il.partial AS is_partial,
       ii.seqno AS column_position,
       ii.name AS column_name
FROM sqlite_schema AS m
JOIN pragma_index_list(m.name) AS il
LEFT JOIN pragma_index_info(il.name) AS ii
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, il.name, ii.seqno;
```

## 5. Workflow definitions stored in data

```sql
SELECT enum_type, enum_value, display_label, display_order,
       color_hex, is_terminal, is_active, metadata
FROM enum_values
ORDER BY enum_type, display_order, enum_value;
```

```sql
SELECT enum_type, from_status, to_status, required_role, requires_comment
FROM status_transitions
ORDER BY enum_type, from_status, to_status, required_role;
```

```sql
SELECT workflow_name, terminal_status, description, created_at
FROM workflow_terminal_states
ORDER BY workflow_name, terminal_status;
```

These three outputs define what states exist, who may move a record and which
states are terminal. Compare them with the server-side transition catalogues in
`GRC/src/lib/grc/workflow/`.

## 6. Roles and effective permission matrix

```sql
SELECT rp.organization_id,
       rp.role_code,
       r.role_name,
       rp.module_code,
       pm.module_name,
       rp.action_code,
       pa.action_name,
       rp.is_allowed,
       rp.scope_to_affiliate
FROM role_permissions AS rp
LEFT JOIN roles AS r ON r.role_code = rp.role_code
LEFT JOIN permission_modules AS pm ON pm.module_code = rp.module_code
LEFT JOIN permission_actions AS pa ON pa.action_code = rp.action_code
ORDER BY rp.organization_id, rp.role_code, rp.module_code, rp.action_code;
```

## 7. Current workflow population by state

```sql
SELECT 'work_papers' AS entity, status, COUNT(*) AS records
FROM work_papers WHERE deleted_at IS NULL GROUP BY status
UNION ALL
SELECT 'action_plans', status, COUNT(*)
FROM action_plans WHERE deleted_at IS NULL GROUP BY status
UNION ALL
SELECT 'auditee_responses', status, COUNT(*)
FROM auditee_responses WHERE deleted_at IS NULL GROUP BY status
UNION ALL
SELECT 'work_paper_requirements', status, COUNT(*)
FROM work_paper_requirements WHERE deleted_at IS NULL GROUP BY status
UNION ALL
SELECT 'requirement_submissions', review_status, COUNT(*)
FROM requirement_submissions GROUP BY review_status
UNION ALL
SELECT 'notification_queue', status, COUNT(*)
FROM notification_queue WHERE deleted_at IS NULL GROUP BY status
ORDER BY entity, status;
```

## 8. High-value relationship checks

Every query should return `0`.

```sql
SELECT 'users_without_organization' AS check_name, COUNT(*) AS failures
FROM users u
WHERE u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.organization_id = u.organization_id
  )
UNION ALL
SELECT 'work_papers_without_organization', COUNT(*)
FROM work_papers wp
WHERE wp.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.organization_id = wp.organization_id
  )
UNION ALL
SELECT 'action_plans_without_work_paper', COUNT(*)
FROM action_plans ap
WHERE ap.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM work_papers wp
    WHERE wp.work_paper_id = ap.work_paper_id
  )
UNION ALL
SELECT 'requirements_without_work_paper', COUNT(*)
FROM work_paper_requirements r
WHERE r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM work_papers wp
    WHERE wp.work_paper_id = r.work_paper_id
  )
UNION ALL
SELECT 'submissions_without_requirement', COUNT(*)
FROM requirement_submissions rs
WHERE NOT EXISTS (
  SELECT 1 FROM work_paper_requirements r
  WHERE r.requirement_id = rs.requirement_id
)
UNION ALL
SELECT 'sessions_without_user', COUNT(*)
FROM sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM users u WHERE u.user_id = s.user_id
);
```

## 9. Tenant-boundary summary

```sql
SELECT organization_id, 'users' AS entity, COUNT(*) AS records
FROM users WHERE deleted_at IS NULL GROUP BY organization_id
UNION ALL
SELECT organization_id, 'work_papers', COUNT(*)
FROM work_papers WHERE deleted_at IS NULL GROUP BY organization_id
UNION ALL
SELECT organization_id, 'action_plans', COUNT(*)
FROM action_plans WHERE deleted_at IS NULL GROUP BY organization_id
UNION ALL
SELECT organization_id, 'requirements', COUNT(*)
FROM work_paper_requirements WHERE deleted_at IS NULL GROUP BY organization_id
UNION ALL
SELECT organization_id, 'notifications', COUNT(*)
FROM notification_queue WHERE deleted_at IS NULL GROUP BY organization_id
ORDER BY organization_id, entity;
```

## Audit sequence

1. Export sections 1–4 to establish the physical schema and integrity.
2. Export sections 5–6 to establish the configured workflow and permissions.
3. Export sections 7–9 to establish how live records occupy those workflows and
   whether their relationships and tenant boundaries hold.
4. Compare every API mutation in `GRC/src/pages/grc/api/` with its repository
   write under `GRC/src/lib/grc/repos/` and its corresponding history/audit row.
5. For every transition, verify the UI action, endpoint permission, configured
   `status_transitions` row, entity update, history row, notification and audit
   event form one consistent transaction or recoverable sequence.
