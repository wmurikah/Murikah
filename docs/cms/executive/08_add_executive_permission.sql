-- ---------------------------------------------------------------------------
-- CMS Build Prompt 24: the executive dashboard as a landing page.
--
-- Run by the operator in the Turso console. The application never runs this.
--
-- WHAT THIS ADDS AND WHY IT IS A NEW CODE.
--
--   PERM-041  EXECUTIVE.DASHBOARD.VIEW  land here at sign-in
--
-- The Executive nav link is already gated, on holding ANY of four codes:
-- ORDERS.SALES_ORDER.VIEW, ORDERS.PURCHASE_ORDER.VIEW, CRM.OPPORTUNITIES.VIEW
-- or SERVICE.CASES.VIEW. That is the right rule for "may this person open the
-- page": the page composes itself from whatever the caller holds, so one code
-- shows one section, which is useful.
--
-- It is the wrong rule for "is this page their home". A person holding only
-- SERVICE.CASES.VIEW would be landed on a dashboard with five of six sections
-- composed away, which is a worse first screen than Home and which nobody
-- chose for them. This code records a decision: this person's day starts on
-- the executive dashboard.
--
-- NOTHING READS A NAME. No email address, no user id and no job title appears
-- in the application code or in this file. A person lands on the dashboard
-- because they hold this code, and stops landing there when it is revoked.
--
-- UNTIL THIS IS RUN, NOBODY HOLDS THE CODE AND EVERYBODY LANDS ON HOME, which
-- is exactly today's behaviour. The default of the change is no change.
--
-- SAFE TO RUN TWICE. NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO permissions (permission_id, module_name, resource_name, action_name, description) VALUES
('PERM-041','EXECUTIVE','DASHBOARD','VIEW','Land on the executive dashboard at sign-in');

-- ROLE-ADMIN, because the seed's grant-everything insert ran before this code
-- existed and a system administrator holding every other code but not this one
-- would be an inconsistency somebody has to explain later.
INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
('RP-ADMIN-PERM-041','ROLE-ADMIN','PERM-041',1,CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- THE OTHER ROLES ARE A DECISION, NOT A DEFAULT, so they are proposed here and
-- left commented. Uncomment the lines for the roles whose people should open
-- their day on this page, and leave the rest shut.
--
-- The test is not seniority. It is whether a person's first question each
-- morning is "where should we be looking across the group", which is what the
-- page answers. Somebody who works one module all day is better served by
-- landing on Home and choosing.
--
-- RECOMMENDED, the two roles whose scope is the whole group:
--
--   ROLE-GRP-FIN   Group Finance. Already reads across every affiliate, and
--                  the commercial and operational halves of this page are the
--                  question they open the product to ask.
--   ROLE-CM        Country Manager. The page is written for this reader:
--                  exceptions first, then how the period moved, across the
--                  modules they are accountable for rather than one of them.
--
-- CONSIDERED AND NOT RECOMMENDED, so the reasoning is on the record:
--
--   ROLE-FIN       Finance Manager. Scoped to one affiliate, so the affiliate
--                  comparison is a one-row table and the page is thinner for
--                  them than Home. Grant it if they ask for it, not before.
--   ROLE-CSM       Customer Service Manager. Holds SERVICE.CASES.VIEW, so
--                  five of the six sections compose away and the landing page
--                  would be mostly absent. The service analytics page is the
--                  better home and they already have it.
--   ROLE-SALES     Sales Executive. Works one pipeline; Home and the CRM
--                  pages are the right start.
--   ROLE-PORTAL    Customer Portal User. External. `homeFor` sends every
--                  EXTERNAL user to /portal before it looks at any code, so
--                  this grant would do nothing even if it were made.
--
-- Confirm the role ids against your own access_roles table before running any
-- of these. An id that does not exist inserts nothing and reports nothing,
-- because of the INSERT OR IGNORE, so a typo here fails silently: the
-- verification query at the bottom is how you check it landed.
-- ---------------------------------------------------------------------------

-- INSERT OR IGNORE INTO role_permissions (role_permission_id, role_id, permission_id, allowed, created_at) VALUES
-- ('RP-GF-041','ROLE-GRP-FIN','PERM-041',1,CURRENT_TIMESTAMP),
-- ('RP-CM-041','ROLE-CM','PERM-041',1,CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Verification. Expect one permission row, and one role row per role granted.
-- ---------------------------------------------------------------------------

SELECT permission_id, module_name, resource_name, action_name
FROM permissions
WHERE permission_id = 'PERM-041';

SELECT rp.role_id, ar.role_name, rp.allowed
FROM role_permissions rp
JOIN access_roles ar ON ar.role_id = rp.role_id
WHERE rp.permission_id = 'PERM-041'
ORDER BY rp.role_id;
