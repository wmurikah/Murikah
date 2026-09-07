-- CY-01: dedicated AI administration permission.
-- Run manually in the Turso SQL console. This file is idempotent and contains
-- no transaction keywords because Drizzle/Turso Studio batches statements.
-- No production database write is performed by this change.

INSERT OR IGNORE INTO permissions
  (permission_id, module_name, resource_name, action_name, description)
VALUES
  ('PERM-ADMIN-AI-MANAGE', 'ADMIN', 'AI', 'MANAGE',
   'Configure and verify approved AI providers');

-- Preserve current System Administrator access while separating AI management
-- from ADMIN.USERS.MANAGE. Other roles receive this permission only by an
-- explicit access-control decision.
INSERT OR IGNORE INTO role_permissions
  (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT
  'RP-ADMIN-PERM-ADMIN-AI-MANAGE',
  'ROLE-ADMIN',
  p.permission_id,
  1,
  CURRENT_TIMESTAMP
FROM permissions p
WHERE p.module_name = 'ADMIN'
  AND p.resource_name = 'AI'
  AND p.action_name = 'MANAGE';

-- Verification: expect one permission row and one ROLE-ADMIN grant.
SELECT
  p.permission_id,
  p.module_name || '.' || p.resource_name || '.' || p.action_name AS permission_code,
  rp.role_id,
  rp.allowed
FROM permissions p
LEFT JOIN role_permissions rp
  ON rp.permission_id = p.permission_id
 AND rp.role_id = 'ROLE-ADMIN'
WHERE p.module_name = 'ADMIN'
  AND p.resource_name = 'AI'
  AND p.action_name = 'MANAGE';
