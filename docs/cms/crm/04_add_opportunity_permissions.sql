-- ---------------------------------------------------------------------------
-- CMS Build Prompt 12: opportunity and pipeline permissions.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- The seed already carries PERM-004, CRM.OPPORTUNITIES.EDIT, granted to
-- ROLE-SALES. Three codes are missing for phase 12:
--
--   PERM-036  CRM.OPPORTUNITIES.VIEW   read the pipeline and the list
--   PERM-037  CRM.PIPELINES.MANAGE     configure pipelines and stages
--   PERM-038  CRM.LOST_REASONS.MANAGE  configure the lost reason list
--
-- VIEW is separate from EDIT for the same reason LEADS.VIEW is separate from
-- LEADS.MANAGE: a person who reads the pipeline in a review meeting is not
-- necessarily a person who may move a deal through it.
--
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-036','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline'),
('PERM-037','CRM','PIPELINES','MANAGE','Configure pipelines and stages'),
('PERM-038','CRM','LOST_REASONS','MANAGE','Configure lost reasons');

-- The administrator role holds everything, by the convention the earlier
-- scripts established: RP-ADMIN- followed by the permission id.
INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions WHERE permission_id IN ('PERM-036','PERM-037','PERM-038');

-- Sales reads the pipeline it already edits. Pipeline and lost-reason
-- configuration stay administrative: a salesperson must not redefine the
-- stages mid-quarter.
INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-SAL-009','ROLE-SALES','PERM-036',1,CURRENT_TIMESTAMP);
