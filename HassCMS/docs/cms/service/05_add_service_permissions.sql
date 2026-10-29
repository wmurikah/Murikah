-- ---------------------------------------------------------------------------
-- CMS Build Prompt 14: customer service permissions.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- The seed already carries PERM-005 SERVICE.CASES.VIEW, PERM-006
-- SERVICE.CASES.CREATE and PERM-007 SERVICE.CASES.REASSIGN, granted to
-- ROLE-CSM. Two codes are missing for phase 14:
--
--   PERM-039  SERVICE.CASES.MANAGE      change status, communicate, resolve,
--                                       close, cancel and reopen a case
--   PERM-040  SERVICE.CATEGORIES.MANAGE configure case categories
--
-- MANAGE is separate from CREATE for the same reason it is on leads: the
-- person who logs a walk-in enquiry is not necessarily the person who may
-- declare it resolved.
--
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-039','SERVICE','CASES','MANAGE','Work, resolve, close and reopen service cases'),
('PERM-040','SERVICE','CATEGORIES','MANAGE','Configure case categories');

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions WHERE permission_id IN ('PERM-039','PERM-040');

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-CS-011','ROLE-CSM','PERM-039',1,CURRENT_TIMESTAMP),
('RP-CS-012','ROLE-CSM','PERM-040',1,CURRENT_TIMESTAMP);
