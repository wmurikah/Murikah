-- ============================================================================
-- 12_reconcile_permission_catalogue.sql  -  every permission code the
--                                           application actually checks
-- ============================================================================
-- Run this in the Turso web console against the database that
-- TURSO_CMS_DATABASE_URL points at. Claude does not run it: every database
-- statement in this product is applied by the operator by hand.
--
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ----------------------------------------------------------------------------
-- The System Administrator cannot open a customer. Clicking a customer's name
-- returns "You do not have access to customers."
--
-- The page requires CUSTOMERS.ACCOUNTS.VIEW (src/lib/cms/nav.ts, and
-- ACCOUNTS_VIEW in src/lib/cms/permissions.ts). The seeded `permissions` table
-- holds 28 rows across ADMIN, AUDIT, CREDIT, CRM, DATA, ORDERS, PORTAL,
-- SERVICE and SLA. There is no CUSTOMERS module in it. The code the page
-- requires does not exist, so nobody can hold it, so everybody is refused --
-- correctly, and indistinguishably from a working guard.
--
-- THAT IS NOT ONE GAP. IT IS SIXTEEN. The application checks 38 distinct codes
-- and the table holds 28, of which only 22 are codes the application checks.
-- Sixteen codes the application requires are absent:
--
--   ADMIN.ORGANISATION.VIEW          ADMIN.ORGANISATION.MANAGE
--   AUDIT.EVENTS.SECURITY_VIEW       AUDIT.EVENTS.EXPORT
--   CRM.LEADS.MANAGE                 CRM.LEAD_SOURCES.MANAGE
--   CRM.OPPORTUNITIES.VIEW           CRM.PIPELINES.MANAGE
--   CRM.LOST_REASONS.MANAGE          SERVICE.CASES.MANAGE
--   SERVICE.CATEGORIES.MANAGE        EXECUTIVE.DASHBOARD.VIEW
--   CUSTOMERS.ACCOUNTS.VIEW          CUSTOMERS.ACCOUNTS.MANAGE
--   CUSTOMERS.PORTAL_ACCESS.VIEW     CUSTOMERS.CREDIT_TERMS.VIEW
--
-- Fifteen of those sixteen are covered by nine earlier scripts under docs/cms/
-- that have never been run. The sixteenth, CUSTOMERS.CREDIT_TERMS.VIEW, is new
-- in this phase. So this is not nine missing scripts: it is nine unapplied
-- ones, which is why the ordering fault below matters.
--
-- ----------------------------------------------------------------------------
-- THE SECOND FAULT, WHICH IS WORSE, AND WHICH THIS SCRIPT ALSO REPAIRS
-- ----------------------------------------------------------------------------
-- Nine earlier scripts under docs/cms/ add permissions, each choosing its own
-- `permission_id` by hand. Two of them chose the same one:
--
--   docs/cms/audit/09_add_audit_permissions.sql      PERM-041 = AUDIT.EVENTS.SECURITY_VIEW
--   docs/cms/executive/08_add_executive_permission.sql PERM-041 = EXECUTIVE.DASHBOARD.VIEW
--
-- `permission_id` is the primary key and both statements are INSERT OR IGNORE,
-- so whichever script runs SECOND is silently discarded. No error, no warning,
-- and the losing code is simply absent for ever. Worse, both scripts then
-- grant PERM-041 to ROLE-ADMIN, so the grant succeeds while pointing at the
-- other script's permission: the catalogue looks populated and one of the two
-- codes can never be held by anybody.
--
-- This script cannot collide, because it does not choose ids by hand. Each id
-- is DERIVED FROM ITS CODE (PERM-CUSTOMERS-ACCOUNTS-VIEW), so two different
-- codes cannot claim one id, and the grants below look their permission up BY
-- CODE rather than by id, so a code that already exists under an older
-- hand-assigned id is granted under that id rather than skipped.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS DATA AND NOT SCHEMA
-- ----------------------------------------------------------------------------
-- No table, column, constraint, index or trigger is added or altered. The
-- `permissions` table exists precisely so that codes can be added to it, and
-- adding a row is using the schema rather than changing it.
--
-- ----------------------------------------------------------------------------
-- SAFE TO RUN TWICE, AND SAFE TO RUN AFTER THE NINE EARLIER SCRIPTS
-- ----------------------------------------------------------------------------
-- Every statement is INSERT OR IGNORE. UNIQUE(module_name, resource_name,
-- action_name) makes a code that already exists a no-op whatever id it carries,
-- and UNIQUE(role_id, permission_id) makes a grant that already exists a no-op
-- too. The counts are identical after one run and after ten.
--
-- It is also a superset of every earlier script's permission rows, so running
-- it is sufficient on its own. The earlier scripts still matter for the role
-- grants they make to roles other than ROLE-ADMIN, which this script does not
-- reproduce.
--
-- ----------------------------------------------------------------------------
-- NO TRANSACTION KEYWORDS
-- ----------------------------------------------------------------------------
-- The Turso console rejects transaction keywords, so there is no BEGIN, no
-- COMMIT and no ROLLBACK anywhere below. Each statement stands alone, and each
-- is idempotent, which is what makes a partial run safe to repeat rather than
-- something to unpick.
--
-- ============================================================================
-- 1. Every permission code the application checks.
-- ============================================================================
-- This list is generated from the exports of src/lib/cms/permissions.ts, which
-- is the single place the application names a code. test/cms/permissionCatalogue.test.ts
-- asserts that this file and that module agree, so the day somebody adds a code
-- in TypeScript and forgets this script, the suite says so rather than an
-- administrator discovering it as a refusal.

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-ADMIN-ORGANISATION-MANAGE','ADMIN','ORGANISATION','MANAGE','Create, edit and deactivate organisation master data'),
('PERM-ADMIN-ORGANISATION-VIEW','ADMIN','ORGANISATION','VIEW','Read countries, affiliates, business units, departments and teams'),
('PERM-ADMIN-PRODUCT_CATALOG-MANAGE','ADMIN','PRODUCT_CATALOG','MANAGE','Manage product groups, categories and products'),
('PERM-ADMIN-ROLES-MANAGE','ADMIN','ROLES','MANAGE','Manage access roles, permissions and scopes'),
('PERM-ADMIN-USERS-MANAGE','ADMIN','USERS','MANAGE','Manage user records and their assignments'),
('PERM-ADMIN-WORKFLOWS-MANAGE','ADMIN','WORKFLOWS','MANAGE','Manage workflow definitions, stages and SLA wiring'),
('PERM-ADMIN-WORKFLOW_ROLES-MANAGE','ADMIN','WORKFLOW_ROLES','MANAGE','Manage workflow roles and approval authority rules'),
('PERM-AUDIT-EVENTS-EXPORT','AUDIT','EVENTS','EXPORT','Export filtered audit evidence'),
('PERM-AUDIT-EVENTS-SECURITY_VIEW','AUDIT','EVENTS','SECURITY_VIEW','View authentication and access security events'),
('PERM-AUDIT-EVENTS-VIEW','AUDIT','EVENTS','VIEW','View the audit trail'),
('PERM-CREDIT-EXCEPTION-APPROVE','CREDIT','EXCEPTION','APPROVE','Approve credit exceptions on sales orders'),
('PERM-CRM-LEADS-ASSIGN','CRM','LEADS','ASSIGN','Assign leads to owners'),
('PERM-CRM-LEADS-CREATE','CRM','LEADS','CREATE','Create leads'),
('PERM-CRM-LEADS-MANAGE','CRM','LEADS','MANAGE','Qualify, convert and disqualify leads'),
('PERM-CRM-LEADS-VIEW','CRM','LEADS','VIEW','View leads'),
('PERM-CRM-LEAD_SOURCES-MANAGE','CRM','LEAD_SOURCES','MANAGE','Manage lead sources and campaigns'),
('PERM-CRM-LOST_REASONS-MANAGE','CRM','LOST_REASONS','MANAGE','Manage the lost reason catalogue'),
('PERM-CRM-OPPORTUNITIES-EDIT','CRM','OPPORTUNITIES','EDIT','Create and edit opportunities'),
('PERM-CRM-OPPORTUNITIES-VIEW','CRM','OPPORTUNITIES','VIEW','View opportunities and the pipeline'),
('PERM-CRM-PIPELINES-MANAGE','CRM','PIPELINES','MANAGE','Manage pipelines and their stages'),
('PERM-CUSTOMERS-ACCOUNTS-MANAGE','CUSTOMERS','ACCOUNTS','MANAGE','Create and edit customer accounts and contacts'),
('PERM-CUSTOMERS-ACCOUNTS-VIEW','CUSTOMERS','ACCOUNTS','VIEW','View customer accounts and their contacts'),
('PERM-CUSTOMERS-CREDIT_TERMS-VIEW','CUSTOMERS','CREDIT_TERMS','VIEW','View a customer credit limit and credit days'),
('PERM-CUSTOMERS-PORTAL_ACCESS-VIEW','CUSTOMERS','PORTAL_ACCESS','VIEW','View which contacts hold customer portal access'),
('PERM-DATA-IMPORTS-UPLOAD','DATA','IMPORTS','UPLOAD','Upload and apply order extracts'),
('PERM-DATA-IMPORTS-VIEW','DATA','IMPORTS','VIEW','View import batches and their outcomes'),
('PERM-EXECUTIVE-DASHBOARD-VIEW','EXECUTIVE','DASHBOARD','VIEW','Land on the executive dashboard at sign-in'),
('PERM-ORDERS-PURCHASE_ORDER-UPLOAD','ORDERS','PURCHASE_ORDER','UPLOAD','Upload purchase order extracts'),
('PERM-ORDERS-PURCHASE_ORDER-VIEW','ORDERS','PURCHASE_ORDER','VIEW','View purchase orders and their performance'),
('PERM-ORDERS-SALES_ORDER-UPLOAD','ORDERS','SALES_ORDER','UPLOAD','Upload sales order extracts'),
('PERM-ORDERS-SALES_ORDER-VIEW','ORDERS','SALES_ORDER','VIEW','View sales orders and their performance'),
('PERM-SERVICE-CASES-CREATE','SERVICE','CASES','CREATE','Create service cases'),
('PERM-SERVICE-CASES-MANAGE','SERVICE','CASES','MANAGE','Progress, resolve and close service cases'),
('PERM-SERVICE-CASES-REASSIGN','SERVICE','CASES','REASSIGN','Reassign a service case to another owner or team'),
('PERM-SERVICE-CASES-VIEW','SERVICE','CASES','VIEW','View service cases'),
('PERM-SERVICE-CATEGORIES-MANAGE','SERVICE','CATEGORIES','MANAGE','Manage case categories'),
('PERM-SLA-DASHBOARD-VIEW','SLA','DASHBOARD','VIEW','View the SLA dashboard'),
('PERM-SLA-RULES-MANAGE','SLA','RULES','MANAGE','Manage SLA profiles, rules and calendars');
-- ============================================================================
-- 2. Grant every one of them to ROLE-ADMIN.
-- ============================================================================
-- BY CODE, NOT BY ID. A code that already exists under an older hand-assigned
-- id (CUSTOMERS.ACCOUNTS.VIEW is PERM-031 if docs/cms/customers/02 was ever
-- run) is granted under THAT id. Selecting rather than listing literals is what
-- makes this correct whether or not the earlier scripts were applied, and in
-- whatever order.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-ADMIN-' || p.permission_id, 'ROLE-ADMIN', p.permission_id, 1, CURRENT_TIMESTAMP
FROM permissions p
WHERE p.module_name || '.' || p.resource_name || '.' || p.action_name IN (
  'ADMIN.ORGANISATION.MANAGE',
  'ADMIN.ORGANISATION.VIEW',
  'ADMIN.PRODUCT_CATALOG.MANAGE',
  'ADMIN.ROLES.MANAGE',
  'ADMIN.USERS.MANAGE',
  'ADMIN.WORKFLOWS.MANAGE',
  'ADMIN.WORKFLOW_ROLES.MANAGE',
  'AUDIT.EVENTS.EXPORT',
  'AUDIT.EVENTS.SECURITY_VIEW',
  'AUDIT.EVENTS.VIEW',
  'CREDIT.EXCEPTION.APPROVE',
  'CRM.LEADS.ASSIGN',
  'CRM.LEADS.CREATE',
  'CRM.LEADS.MANAGE',
  'CRM.LEADS.VIEW',
  'CRM.LEAD_SOURCES.MANAGE',
  'CRM.LOST_REASONS.MANAGE',
  'CRM.OPPORTUNITIES.EDIT',
  'CRM.OPPORTUNITIES.VIEW',
  'CRM.PIPELINES.MANAGE',
  'CUSTOMERS.ACCOUNTS.MANAGE',
  'CUSTOMERS.ACCOUNTS.VIEW',
  'CUSTOMERS.CREDIT_TERMS.VIEW',
  'CUSTOMERS.PORTAL_ACCESS.VIEW',
  'DATA.IMPORTS.UPLOAD',
  'DATA.IMPORTS.VIEW',
  'EXECUTIVE.DASHBOARD.VIEW',
  'ORDERS.PURCHASE_ORDER.UPLOAD',
  'ORDERS.PURCHASE_ORDER.VIEW',
  'ORDERS.SALES_ORDER.UPLOAD',
  'ORDERS.SALES_ORDER.VIEW',
  'SERVICE.CASES.CREATE',
  'SERVICE.CASES.MANAGE',
  'SERVICE.CASES.REASSIGN',
  'SERVICE.CASES.VIEW',
  'SERVICE.CATEGORIES.MANAGE',
  'SLA.DASHBOARD.VIEW',
  'SLA.RULES.MANAGE'
);

-- ============================================================================
-- 3. The other roles proposed for the customer codes.
-- ============================================================================
-- WHAT IS PROPOSED, AND WHAT IS DELIBERATELY NOT.
--
-- CUSTOMERS.ACCOUNTS.VIEW goes to Sales, Credit, Customer Service and Finance.
-- Every one of those roles already works from a customer record: a sales
-- executive opening an opportunity, a credit officer releasing an order, an
-- agent taking a case. A role that can act on a customer's order and cannot
-- read the customer is a workflow with a hole in it.
--
-- CUSTOMERS.ACCOUNTS.MANAGE goes to ROLE-ADMIN alone in this script. Editing a
-- customer master record changes what every downstream import matches on, and
-- widening that is a decision for the business rather than a default.
--
-- CUSTOMERS.CREDIT_TERMS.VIEW IS A SEPARATE CODE, AND THAT IS THE POINT.
-- A credit limit and credit days are commercially sensitive: they say what the
-- business will carry for this customer, and a service agent reading a case
-- does not need to know it. So the two credit fields on the customer record are
-- gated on their own code rather than on ACCOUNTS.VIEW, and this script grants
-- it to ROLE-ADMIN, Credit and Finance only. Not to Sales and not to Customer
-- Service.
--
-- CONTACTS DO NOT GET THEIR OWN CODE, and that is also deliberate. A contact is
-- part of a customer record rather than a thing beside it, and a person who can
-- read the account but not its contacts is a state nobody has asked for and the
-- screens have no shape for. Portal ACCESS is different and already has its own
-- code, because holding a portal login is an access fact rather than a contact
-- detail.
--
-- Roles referenced below that do not exist are skipped by the join rather than
-- failing the script.

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-' || ar.role_id || '-' || p.permission_id, ar.role_id, p.permission_id, 1, CURRENT_TIMESTAMP
FROM permissions p
JOIN access_roles ar ON ar.role_id IN ('ROLE-SALES','ROLE-CRD','ROLE-CS','ROLE-FIN')
WHERE p.module_name = 'CUSTOMERS' AND p.resource_name = 'ACCOUNTS' AND p.action_name = 'VIEW';

INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at)
SELECT 'RP-' || ar.role_id || '-' || p.permission_id, ar.role_id, p.permission_id, 1, CURRENT_TIMESTAMP
FROM permissions p
JOIN access_roles ar ON ar.role_id IN ('ROLE-CRD','ROLE-FIN')
WHERE p.module_name = 'CUSTOMERS' AND p.resource_name = 'CREDIT_TERMS' AND p.action_name = 'VIEW';

-- ============================================================================
-- 4. Verification. Read the output. Nothing below writes.
-- ============================================================================

-- (a) EVERY CODE THE APPLICATION CHECKS THAT THE TABLE STILL LACKS.
--     EXPECT NO ROWS. Any row here is a page nobody can open.
WITH required(code) AS (VALUES
  ('ADMIN.ORGANISATION.MANAGE'),
  ('ADMIN.ORGANISATION.VIEW'),
  ('ADMIN.PRODUCT_CATALOG.MANAGE'),
  ('ADMIN.ROLES.MANAGE'),
  ('ADMIN.USERS.MANAGE'),
  ('ADMIN.WORKFLOWS.MANAGE'),
  ('ADMIN.WORKFLOW_ROLES.MANAGE'),
  ('AUDIT.EVENTS.EXPORT'),
  ('AUDIT.EVENTS.SECURITY_VIEW'),
  ('AUDIT.EVENTS.VIEW'),
  ('CREDIT.EXCEPTION.APPROVE'),
  ('CRM.LEADS.ASSIGN'),
  ('CRM.LEADS.CREATE'),
  ('CRM.LEADS.MANAGE'),
  ('CRM.LEADS.VIEW'),
  ('CRM.LEAD_SOURCES.MANAGE'),
  ('CRM.LOST_REASONS.MANAGE'),
  ('CRM.OPPORTUNITIES.EDIT'),
  ('CRM.OPPORTUNITIES.VIEW'),
  ('CRM.PIPELINES.MANAGE'),
  ('CUSTOMERS.ACCOUNTS.MANAGE'),
  ('CUSTOMERS.ACCOUNTS.VIEW'),
  ('CUSTOMERS.CREDIT_TERMS.VIEW'),
  ('CUSTOMERS.PORTAL_ACCESS.VIEW'),
  ('DATA.IMPORTS.UPLOAD'),
  ('DATA.IMPORTS.VIEW'),
  ('EXECUTIVE.DASHBOARD.VIEW'),
  ('ORDERS.PURCHASE_ORDER.UPLOAD'),
  ('ORDERS.PURCHASE_ORDER.VIEW'),
  ('ORDERS.SALES_ORDER.UPLOAD'),
  ('ORDERS.SALES_ORDER.VIEW'),
  ('SERVICE.CASES.CREATE'),
  ('SERVICE.CASES.MANAGE'),
  ('SERVICE.CASES.REASSIGN'),
  ('SERVICE.CASES.VIEW'),
  ('SERVICE.CATEGORIES.MANAGE'),
  ('SLA.DASHBOARD.VIEW'),
  ('SLA.RULES.MANAGE')
)
SELECT r.code AS missing_permission_code
FROM required r
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.module_name || '.' || p.resource_name || '.' || p.action_name = r.code
)
ORDER BY 1;

-- (b) THE PERM-041 COLLISION, RESOLVED. Expect two rows, one for each code,
--     carrying whatever ids they ended up with.
SELECT permission_id, module_name || '.' || resource_name || '.' || action_name AS code
FROM permissions
WHERE (module_name = 'AUDIT' AND resource_name = 'EVENTS' AND action_name = 'SECURITY_VIEW')
   OR (module_name = 'EXECUTIVE' AND resource_name = 'DASHBOARD' AND action_name = 'VIEW')
ORDER BY code;

-- (c) The catalogue's size. Expect 44. It was 28 before any script ran, and
--     this one adds the 16 codes the application checks that were absent.
SELECT COUNT(*) AS permission_count FROM permissions;

-- (d) THE RESOLVED PERMISSION COUNT FOR THE SYSTEM ADMINISTRATOR, Catherine
--     Mwangi. It is 28 today.
--
--     EXPECT 44.
--
--     The arithmetic, so the number can be checked rather than trusted. The
--     table holds 28 rows. The application checks 38 codes. Sixteen of those 38
--     are absent from the table and this script adds them, and the other 22 are
--     already there. 28 + 16 = 44. The six rows that make up the difference
--     between 28 and 22 are the PORTAL module, which the portal host
--     deliberately does not authorise on -- src/lib/cms/portal/guard.ts asks
--     "does this external user hold a live membership naming this account"
--     rather than asking for a code -- so those six are granted and never read.
--     Query (e) lists them.
--
--     This figure is verified: test/cms/permissionCatalogue.test.ts runs this
--     file verbatim against a database seeded with the same 28 rows and the
--     same nine modules as this one, and prints the resolved count.
--
--     The earlier acceptance criteria that name 28 should be updated to 44
--     rather than read as a regression.
--
--     This is the application's own resolver, copied from
--     src/lib/cms/repos/identity.ts, so the number the console prints is the
--     number the running product will compute rather than a second opinion.
SELECT COUNT(DISTINCT p.module_name || '.' || p.resource_name || '.' || p.action_name)
       AS resolved_permissions
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.allowed = 1
JOIN permissions p ON p.permission_id = rp.permission_id
WHERE ur.user_id = 'USR-CATH'
  AND ur.active = 1
  AND ur.effective_from <= date('now')
  AND (ur.effective_to IS NULL OR ur.effective_to >= date('now'));

-- (e) EVERY CODE THE TABLE HOLDS THAT THE APPLICATION NEVER CHECKS.
--     Not a fault, and worth knowing: a granted code nothing reads is a
--     permission that cannot be audited by observing behaviour.
WITH required(code) AS (VALUES
  ('ADMIN.ORGANISATION.MANAGE'),
  ('ADMIN.ORGANISATION.VIEW'),
  ('ADMIN.PRODUCT_CATALOG.MANAGE'),
  ('ADMIN.ROLES.MANAGE'),
  ('ADMIN.USERS.MANAGE'),
  ('ADMIN.WORKFLOWS.MANAGE'),
  ('ADMIN.WORKFLOW_ROLES.MANAGE'),
  ('AUDIT.EVENTS.EXPORT'),
  ('AUDIT.EVENTS.SECURITY_VIEW'),
  ('AUDIT.EVENTS.VIEW'),
  ('CREDIT.EXCEPTION.APPROVE'),
  ('CRM.LEADS.ASSIGN'),
  ('CRM.LEADS.CREATE'),
  ('CRM.LEADS.MANAGE'),
  ('CRM.LEADS.VIEW'),
  ('CRM.LEAD_SOURCES.MANAGE'),
  ('CRM.LOST_REASONS.MANAGE'),
  ('CRM.OPPORTUNITIES.EDIT'),
  ('CRM.OPPORTUNITIES.VIEW'),
  ('CRM.PIPELINES.MANAGE'),
  ('CUSTOMERS.ACCOUNTS.MANAGE'),
  ('CUSTOMERS.ACCOUNTS.VIEW'),
  ('CUSTOMERS.CREDIT_TERMS.VIEW'),
  ('CUSTOMERS.PORTAL_ACCESS.VIEW'),
  ('DATA.IMPORTS.UPLOAD'),
  ('DATA.IMPORTS.VIEW'),
  ('EXECUTIVE.DASHBOARD.VIEW'),
  ('ORDERS.PURCHASE_ORDER.UPLOAD'),
  ('ORDERS.PURCHASE_ORDER.VIEW'),
  ('ORDERS.SALES_ORDER.UPLOAD'),
  ('ORDERS.SALES_ORDER.VIEW'),
  ('SERVICE.CASES.CREATE'),
  ('SERVICE.CASES.MANAGE'),
  ('SERVICE.CASES.REASSIGN'),
  ('SERVICE.CASES.VIEW'),
  ('SERVICE.CATEGORIES.MANAGE'),
  ('SLA.DASHBOARD.VIEW'),
  ('SLA.RULES.MANAGE')
)
SELECT p.module_name || '.' || p.resource_name || '.' || p.action_name AS unchecked_code
FROM permissions p
WHERE p.module_name || '.' || p.resource_name || '.' || p.action_name NOT IN (SELECT code FROM required)
ORDER BY 1;
