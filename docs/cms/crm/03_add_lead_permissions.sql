-- ============================================================================
-- 03_add_lead_permissions.sql  -  the two codes lead management needs and the
--                                 seeded catalogue does not have
-- ============================================================================
-- Run this in the Turso web console against the database that
-- TURSO_CMS_DATABASE_URL points at. Claude does not run it.
--
-- WHY ONLY TWO
-- The seed already carries most of what this phase authorises against:
--   PERM-001  CRM.LEADS.VIEW           read a lead
--   PERM-002  CRM.LEADS.CREATE         create one
--   PERM-003  CRM.LEADS.ASSIGN         change its owner
--   PERM-004  CRM.OPPORTUNITIES.EDIT   what conversion produces
-- Two things have no code at all.
--
-- CRM.LEADS.MANAGE covers editing, recording first contact, qualifying,
-- disqualifying and converting. Those are not creation: the person who takes a
-- web enquiry is often not the person who decides it is qualified, and folding
-- them into CRM.LEADS.CREATE would mean anyone who can log an enquiry can also
-- declare it dead. Conversion additionally requires CRM.OPPORTUNITIES.EDIT,
-- because it writes an opportunity, so the two are checked together there.
--
-- CRM.LEAD_SOURCES.MANAGE covers the settings screen. A lead source is
-- configuration that every lead references with ON DELETE RESTRICT, so
-- deactivating one changes what the whole organisation can select. That is an
-- administrative act, not a sales one.
--
-- WHY THIS IS DATA AND NOT SCHEMA
-- No table, column, constraint, index or trigger is added or altered.
--
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The permission codes
-- ----------------------------------------------------------------------------
-- Ids continue the sequence: the seed ends at PERM-028, script 01 added 029 and
-- 030, script 02 added 031 to 033.

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-034','CRM','LEADS','MANAGE','Edit, qualify, disqualify and convert leads'),
('PERM-035','CRM','LEAD_SOURCES','MANAGE','Create, edit and deactivate lead sources');

-- ----------------------------------------------------------------------------
-- 2. Grant to the System Administrator
-- ----------------------------------------------------------------------------

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions
WHERE permission_id IN ('PERM-034','PERM-035');

-- ----------------------------------------------------------------------------
-- 3. Grant MANAGE to Sales, and to nobody else
-- ----------------------------------------------------------------------------
-- ROLE-SALES already holds CRM.LEADS.VIEW, CREATE and CRM.OPPORTUNITIES.EDIT
-- (RP-SAL-001 to RP-SAL-004), so it is the role that already owns this work.
--
-- Customer Service holds CRM.LEADS.VIEW and CREATE, because a service call is
-- one of the seeded lead sources and an agent who spots an opportunity should
-- be able to log it. They are not given MANAGE: qualifying and disqualifying a
-- commercial lead is a sales judgement, and an agent who could disqualify one
-- could close off revenue from a screen they opened for another reason.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-SAL-008','ROLE-SALES','PERM-034',1,CURRENT_TIMESTAMP);

-- ----------------------------------------------------------------------------
-- 4. LEAD_SOURCES.MANAGE goes to the administrator only
-- ----------------------------------------------------------------------------
-- Section 2 of the seed grants it to ROLE-ADMIN. Nothing else is added here. If
-- a country sales organisation later needs to add its own sources, the answer
-- is a grant in this same form, not a wider code.

-- ============================================================================
-- 5. Verification. Read the output. Nothing below writes.
-- ============================================================================

SELECT permission_id, module_name, resource_name, action_name
FROM permissions
WHERE module_name = 'CRM' AND resource_name IN ('LEADS','LEAD_SOURCES')
ORDER BY permission_id;

-- Expect 35. It was 33 after script 02.
SELECT COUNT(*) AS permission_count FROM permissions;

-- Expect three rows: ROLE-ADMIN holding both, ROLE-SALES holding MANAGE.
SELECT rp.role_id, ar.role_name,
       p.module_name || '.' || p.resource_name || '.' || p.action_name AS code
FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN access_roles ar ON ar.role_id = rp.role_id
WHERE p.permission_id IN ('PERM-034','PERM-035')
ORDER BY rp.role_id, p.resource_name;

-- The resolved permission count for the System Administrator. Expect 35.
SELECT COUNT(DISTINCT p.module_name || '.' || p.resource_name || '.' || p.action_name)
       AS resolved_permissions
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE ur.user_id = 'USR-CATH'
  AND ur.active = 1
  AND ur.effective_from <= date('now')
  AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'));
