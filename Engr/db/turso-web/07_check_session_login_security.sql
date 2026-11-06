-- Run first in Turso Web. Before migration 005 this should list all three tables
-- and all six triggers. If nothing is returned, do not run 08 again.
WITH required(type, name) AS (
  VALUES
    ('table', 'auth_sessions'),
    ('table', 'auth_login_limits'),
    ('table', 'auth_login_events'),
    ('trigger', 'trg_users_security_revoke'),
    ('trigger', 'trg_organisations_security_revoke'),
    ('trigger', 'trg_user_roles_security_insert'),
    ('trigger', 'trg_user_roles_security_delete'),
    ('trigger', 'trg_role_permissions_security_insert'),
    ('trigger', 'trg_role_permissions_security_delete')
)
SELECT required.type AS missing_type, required.name AS missing_object
FROM required
LEFT JOIN sqlite_schema
  ON sqlite_schema.type = required.type AND sqlite_schema.name = required.name
WHERE sqlite_schema.name IS NULL
ORDER BY required.type, required.name;

SELECT id, description, checksum, applied_at
FROM schema_migrations
WHERE id = '005';
