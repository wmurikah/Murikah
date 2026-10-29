-- ============================================================================
-- 02_add_customer_permissions.sql  -  the permissions the customer workspace
--                                     authorises against
-- ============================================================================
-- Run this in the Turso web console against the database that
-- TURSO_CMS_DATABASE_URL points at. Claude does not run it: every database
-- statement in this product is applied by the operator by hand.
--
-- WHY THIS EXISTS
-- The seeded `permissions` table has no CUSTOMERS module at all. Its CRM module
-- covers LEADS and OPPORTUNITIES, SERVICE covers CASES, ORDERS covers the two
-- order types, and nothing covers the account itself. Until this script runs,
-- every endpoint under /api/cms/customers correctly refuses everyone, including
-- the System Administrator, because there is no code for them to hold.
--
-- The navigation model has referenced CUSTOMERS.ACCOUNTS.VIEW since Build
-- Prompt 02, when the codes were written against the schema before the seed was
-- available. This script is what makes that reference resolve to a real row.
--
-- WHY THIS IS DATA AND NOT SCHEMA
-- No table, column, constraint, index or trigger is added or altered. The
-- `permissions` table exists precisely so codes can be added to it.
--
-- SAFE TO RUN TWICE
-- Every statement is INSERT OR IGNORE against an explicit primary key. Verify
-- with the read-only SELECTs at the end: the counts are identical after one run
-- and after ten.
--
-- NO TRANSACTION KEYWORDS
-- The Turso console rejects transaction keywords anywhere but the last line of a
-- script, so this file uses none. If the console stops part way, re-run the
-- whole file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The permission codes
-- ----------------------------------------------------------------------------
-- Ids continue the sequence. The seed ends at PERM-028 and script 01 added
-- PERM-029 and PERM-030, so these start at PERM-031.
--
-- VIEW is split from MANAGE for the same reason it is on organisation master
-- data. Reading the customer is what most of the product does: a service agent
-- opening a case, a finance approver checking an order, a country manager
-- reading a pipeline all need the account behind the record. Changing it is a
-- narrower job, and an account manager change silently reroutes ownership and
-- data visibility.
--
-- PORTAL_ACCESS.VIEW is separate and deliberately narrow. It governs one thing:
-- whether the contact card shows that a contact has portal access, and in which
-- state. That is a fact about an external person's credentials, so it is not
-- bundled into the ordinary customer read that most of the organisation holds.
-- It is not PORTAL.ACCOUNT.VIEW, PERM-022, which is the permission the external
-- customer themselves holds over their own account.

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-031','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
('PERM-032','CUSTOMERS','ACCOUNTS','MANAGE','Create and edit customer accounts and contacts'),
('PERM-033','CUSTOMERS','PORTAL_ACCESS','VIEW','See whether a contact holds customer portal access');

-- ----------------------------------------------------------------------------
-- 2. Grant to the System Administrator
-- ----------------------------------------------------------------------------
-- The seed granted ROLE-ADMIN every permission through a SELECT over the whole
-- table, with the id built as 'RP-ADMIN-' || permission_id. That statement has
-- already run, so it will not pick these up. This repeats it in the same form
-- and with the same id convention.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions
WHERE permission_id IN ('PERM-031','PERM-032','PERM-033');

-- ----------------------------------------------------------------------------
-- 3. Grant VIEW to the roles that already read customer-adjacent records
-- ----------------------------------------------------------------------------
-- These five roles already hold PERM-001, PERM-005 or PERM-008, which are
-- leads, cases and sales orders. Every one of those records names an account,
-- and a role that can open the record but not the customer behind it is reading
-- half a page.
--
-- MANAGE goes to Sales and to Customer Service, who create accounts in the
-- course of their work: a new prospect arrives through a lead, and a walk-in
-- customer arrives through a case. It does not go to Finance, Credit or the
-- Country Manager, who consume the customer record rather than author it.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-CS-008','ROLE-CSM','PERM-031',1,CURRENT_TIMESTAMP),
('RP-CS-009','ROLE-CSM','PERM-032',1,CURRENT_TIMESTAMP),
('RP-SAL-006','ROLE-SALES','PERM-031',1,CURRENT_TIMESTAMP),
('RP-SAL-007','ROLE-SALES','PERM-032',1,CURRENT_TIMESTAMP),
('RP-FIN-006','ROLE-FIN','PERM-031',1,CURRENT_TIMESTAMP),
('RP-CRD-006','ROLE-CRD','PERM-031',1,CURRENT_TIMESTAMP),
('RP-CM-007','ROLE-CM','PERM-031',1,CURRENT_TIMESTAMP);

-- ----------------------------------------------------------------------------
-- 4. PORTAL_ACCESS.VIEW goes to two roles, and no further
-- ----------------------------------------------------------------------------
-- Customer Service manages the relationship with the people who hold portal
-- logins, so they need to see the state. The System Administrator has it from
-- section 2. Nobody else is given it: a finance approver has no reason to know
-- whether a customer contact can sign in.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-CS-010','ROLE-CSM','PERM-033',1,CURRENT_TIMESTAMP);

-- ============================================================================
-- 5. Verification. Read the output. Nothing below writes.
-- ============================================================================

-- Expect exactly the three rows added above.
SELECT permission_id, module_name, resource_name, action_name
FROM permissions
WHERE module_name = 'CUSTOMERS'
ORDER BY permission_id;

-- Expect 33. It was 30 after script 01.
SELECT COUNT(*) AS permission_count FROM permissions;

-- Expect eleven rows: ROLE-ADMIN holding all three, and the grants above.
SELECT rp.role_id, ar.role_name,
       p.module_name || '.' || p.resource_name || '.' || p.action_name AS code,
       rp.allowed
FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN access_roles ar ON ar.role_id = rp.role_id
WHERE p.module_name = 'CUSTOMERS'
ORDER BY rp.role_id, p.resource_name, p.action_name;

-- The resolved permission count for the System Administrator, Catherine Mwangi.
-- Expect 33. It was 30 after script 01. This is the application's own resolver,
-- copied from src/lib/cms/repos/identity.ts, so the number the console prints is
-- the number the running product computes.
SELECT COUNT(DISTINCT p.module_name || '.' || p.resource_name || '.' || p.action_name)
       AS resolved_permissions
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE ur.user_id = 'USR-CATH'
  AND ur.active = 1
  AND ur.effective_from <= date('now')
  AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'));
