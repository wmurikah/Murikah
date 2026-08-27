-- ============================================================================
-- 01_add_organisation_permissions.sql  -  the permissions the Organisation
--                                         workspace authorises against
-- ============================================================================
-- Run this in the Turso web console against the database that
-- TURSO_CMS_DATABASE_URL points at. Claude does not run it: every database
-- statement in this product is applied by the operator by hand.
--
-- WHY THIS EXISTS
-- The seeded `permissions` table holds 28 rows. Its ADMIN module covers ROLES,
-- USERS, WORKFLOWS, WORKFLOW_ROLES and PRODUCT_CATALOG, and nothing covers
-- organisation master data. Until this script runs, every endpoint under
-- /api/admin/{countries,affiliates,business-units,departments,teams} correctly
-- refuses everyone, including the System Administrator, because there is no
-- permission code for them to hold.
--
-- WHY THIS IS DATA AND NOT SCHEMA
-- No table, column, constraint, index or trigger is added or altered. The
-- `permissions` table exists precisely so that codes can be added to it; adding
-- a row is using the schema, not changing it.
--
-- SAFE TO RUN TWICE
-- Every statement is INSERT OR IGNORE against an explicit primary key, and the
-- UNIQUE(module_name, resource_name, action_name) and UNIQUE(role_id,
-- permission_id) constraints make a second run a no-op rather than a duplicate.
-- Verify with the read-only SELECTs below: the counts are identical after one
-- run and after ten.
--
-- NO TRANSACTION KEYWORDS
-- The Turso console rejects transaction keywords anywhere but the last line of
-- a script, so this file uses none of them. Each statement stands alone. If the
-- console stops part way, re-run the whole file: see SAFE TO RUN TWICE.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The permission codes
-- ----------------------------------------------------------------------------
-- Ids continue the seed's own sequence. The last seeded row is PERM-028.
--
-- The split is VIEW from MANAGE, and it is deliberate. Reading the organisation
-- is something many roles legitimately need: a Country Manager approving a
-- purchase order should be able to see which affiliate and business unit a team
-- belongs to without being able to rename a country. Changing it is
-- configuration, and configuration that silently reshapes reporting lines,
-- approval routing and data visibility for everybody. One code for both would
-- have forced that choice: either give the Country Manager the ability to edit
-- master data, or blind them to it. Neither is right.
--
-- It is two codes rather than five (one per entity) because these five tables
-- are one subject. Nobody has a coherent reason to administer departments but
-- not business units, and five codes would be five more things to get wrong in
-- the role matrix for no gain in expressiveness that anyone asked for.

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-029','ADMIN','ORGANISATION','VIEW','View countries, affiliates, business units, departments and teams'),
('PERM-030','ADMIN','ORGANISATION','MANAGE','Create, edit and deactivate organisation master data');

-- ----------------------------------------------------------------------------
-- 2. Grant to the System Administrator
-- ----------------------------------------------------------------------------
-- The seed grants ROLE-ADMIN every permission through a SELECT over the whole
-- `permissions` table, with the id built as 'RP-ADMIN-' || permission_id. That
-- statement already ran, so it will not pick these two up; this repeats it in
-- the same form and with the same id convention, so the result is identical to
-- what the seed would have produced had these rows existed then.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || permission_id, 'ROLE-ADMIN', permission_id, 1, CURRENT_TIMESTAMP
FROM permissions
WHERE permission_id IN ('PERM-029','PERM-030');

-- ----------------------------------------------------------------------------
-- 3. Grant VIEW, and only VIEW, to the Country Manager
-- ----------------------------------------------------------------------------
-- ROLE-CM already holds five read permissions across customers, cases, orders
-- and dashboards (RP-CM-001 to RP-CM-005). A Country Manager who can see a
-- team's SLA performance but cannot see which affiliate that team sits in is
-- reading half a page. VIEW is additive and discloses no customer or financial
-- data, so it is granted here.
--
-- MANAGE is not. A Country Manager renaming a country or deactivating an
-- affiliate changes what every other country sees, and that is the System
-- Administrator's job. If a country organisation later needs to administer its
-- own teams, the answer is the data scopes already on `user_role_scopes`, not a
-- wider permission code.
--
-- No other role is granted either code. Customer Service, Sales, Credit,
-- Finance, Group Finance and the Customer Portal role have no stake in
-- organisation master data, and a permission nobody needs is a permission
-- nobody should hold.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-CM-006','ROLE-CM','PERM-029',1,CURRENT_TIMESTAMP);

-- ============================================================================
-- 4. Verification. Read the output; nothing below writes.
-- ============================================================================

-- Expect exactly the two rows added above.
SELECT permission_id, module_name, resource_name, action_name
FROM permissions
WHERE module_name = 'ADMIN' AND resource_name = 'ORGANISATION'
ORDER BY permission_id;

-- Expect 30. It was 28 before this script.
SELECT COUNT(*) AS permission_count FROM permissions;

-- Expect three rows: ROLE-ADMIN holding both, ROLE-CM holding VIEW only.
SELECT rp.role_id, ar.role_name, p.module_name || '.' || p.resource_name || '.' || p.action_name AS code, rp.allowed
FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN access_roles ar ON ar.role_id = rp.role_id
WHERE p.resource_name = 'ORGANISATION'
ORDER BY rp.role_id, p.action_name;

-- The resolved permission count for the System Administrator, Catherine Mwangi.
-- Expect 30. Build Prompt 04 recorded 28; this script is why the number moved,
-- and the earlier assertion should be updated to 30 rather than read as a
-- regression.
-- This is the application's own resolver, copied from
-- src/lib/cms/repos/identity.ts, so the number the console prints is the number
-- the running product will compute rather than a second opinion about it.
SELECT COUNT(DISTINCT p.module_name || '.' || p.resource_name || '.' || p.action_name)
       AS resolved_permissions
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE ur.user_id = 'USR-CATH'
  AND ur.active = 1
  AND ur.effective_from <= date('now')
  AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'));
