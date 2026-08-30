-- ---------------------------------------------------------------------------
-- CMS Build Prompt 26: the two audit permission codes that do not exist.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- The catalogue holds AUDIT.EVENTS.VIEW as PERM-020 and nothing else for
-- audit. Build Prompt 26 needs two more, and there is no export permission
-- anywhere in the catalogue for any module, so the second one is new ground.
--
--   PERM-041  AUDIT.EVENTS.SECURITY_VIEW  the authentication and access view
--   PERM-042  AUDIT.EVENTS.EXPORT         taking audit evidence out
--
-- WHY SECURITY_VIEW IS SEPARATE FROM VIEW.
-- PERM-020 is already held by the affiliate and group finance roles, because
-- a finance manager reviewing an approval needs to see what happened to the
-- order. That is not the same as reading sign-in failures, password resets,
-- role grants and scope changes, which are investigative material about
-- people. A country administrator has no business reading Group role
-- changes, and this code is what makes the difference expressible.
--
-- WHY EXPORT IS SEPARATE FROM BOTH.
-- Reading a row on screen and carrying a filtered evidence file out of the
-- building are different acts with different consequences. Exports are also
-- the one path by which audit content leaves the controls that protect it,
-- so it is the one worth naming.
--
-- WHAT IS PROPOSED, AND WHAT IS DELIBERATELY NOT
--
--   ROLE-ADMIN     both codes. The system administrator already holds every
--                  permission through the seed's grant-everything insert;
--                  these two are added explicitly so the grant is visible in
--                  the same place as the others rather than implied.
--
--   ROLE-GRP-FIN   both codes. Group finance already holds PERM-020 and is
--                  the role that reviews approval authority across entities,
--                  which is exactly what the security view is for.
--
--   ROLE-FIN       NEITHER, on purpose. The affiliate finance manager holds
--                  PERM-020 and can already see what happened to the orders
--                  in their scope. Sign-in failures and role grants are not
--                  their work, and an export of audit evidence is not either.
--                  If a particular affiliate needs one, grant it to that
--                  person's role deliberately rather than to the role class.
--
--   ROLE-CM, ROLE-CSM, ROLE-CRD, ROLE-SALES, ROLE-PORTAL
--                  NEITHER. None of them holds PERM-020 today and none has a
--                  reason to read security events.
--
-- UNTIL THIS SCRIPT HAS RUN, THE SECURITY VIEW AND THE AUDIT EXPORT REFUSE
-- EVERYONE, including the system administrator. That is correct behaviour
-- and not a defect: the permissions table is the authority, the application
-- checks a code that does not yet exist, and no code means no access. The
-- interface says so by name rather than rendering an empty screen.
--
-- SAFE TO RUN TWICE. Data only, INSERT OR IGNORE, no transaction keywords.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-041','AUDIT','EVENTS','SECURITY_VIEW','View authentication and access security events'),
('PERM-042','AUDIT','EVENTS','EXPORT','Export filtered audit evidence');

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-ADM-041','ROLE-ADMIN','PERM-041',1,CURRENT_TIMESTAMP),
('RP-ADM-042','ROLE-ADMIN','PERM-042',1,CURRENT_TIMESTAMP),
('RP-GF-041','ROLE-GRP-FIN','PERM-041',1,CURRENT_TIMESTAMP),
('RP-GF-042','ROLE-GRP-FIN','PERM-042',1,CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Verification. Expect two permission rows and four grants across two roles.
-- ---------------------------------------------------------------------------

SELECT p.permission_id, p.module_name || '.' || p.resource_name || '.' || p.action_name AS code,
       r.role_id, r.role_name
  FROM permissions p
  LEFT JOIN role_permissions rp ON rp.permission_id = p.permission_id AND rp.allowed = 1
  LEFT JOIN access_roles r ON r.role_id = rp.role_id
 WHERE p.permission_id IN ('PERM-041','PERM-042')
 ORDER BY p.permission_id, r.role_id;
