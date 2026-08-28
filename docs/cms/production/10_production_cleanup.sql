-- ###########################################################################
-- #                                                                         #
-- #   THIS SCRIPT DELETES DATA. IT IS THE MOST DANGEROUS FILE IN THE         #
-- #   PROJECT. DO NOT RUN IT UNTIL EVERY LINE BELOW IS TRUE.                 #
-- #                                                                         #
-- #     1. A person has read it end to end.                                  #
-- #     2. It has been run against a RESTORED COPY of the target database,   #
-- #        not against a fresh one, and the verification at the bottom       #
-- #        returned zero on that copy.                                       #
-- #     3. A backup of the target database exists and its restore has been   #
-- #        tested. Not "a backup exists": a restore has been tested.         #
-- #     4. The operator running it can name what it will delete.             #
-- #                                                                         #
-- #   IT HAS NOT BEEN RUN BY ANYBODY. The build environment has no           #
-- #   credentials for a live database and running SQL against one is a stop  #
-- #   condition for the phase that wrote this. Nothing here has been         #
-- #   executed; it has been read, ordered and reasoned about, and that is    #
-- #   a different thing from being tested.                                   #
-- #                                                                         #
-- ###########################################################################
--
-- CMS Build Prompt 29: production bootstrap and demo-seed cleanup.
--
-- WHAT IT REMOVES
-- The demo seed that `hass_cms_turso_v1_FINAL.sql` creates: five demo
-- customers and their contacts, five external portal users, the demo internal
-- users, the synthetic leads, opportunities, cases, activities, orders and
-- everything hanging off them. Production must not contain a customer called
-- "BluePeak Transport Ltd" and must not contain an external user who can sign
-- in to see it.
--
-- WHAT IT KEEPS, AND THIS IS THE PART TO GET RIGHT
--   - The permission catalogue and every role. They are configuration, not
--     demo data, and every script from 01 to 09 grants against them.
--   - Countries, affiliates, business units, departments and teams. The real
--     Hass structure was seeded with the demo, and deleting it would take the
--     organisation with the examples.
--   - Workflow definitions, stages, SLA profiles, rules and calendars. Same
--     reason: they are the configuration the business runs on.
--   - The product catalogue.
--   - `audit_events`. NOTHING IN THIS SCRIPT DELETES AN AUDIT ROW, and after
--     script 08 nothing could: the triggers refuse it. That is deliberate and
--     it has a consequence stated under ORDER below.
--
-- WHY THE ORDER MATTERS
-- Foreign keys are declared ON DELETE CASCADE in some places and RESTRICT in
-- others. A delete in the wrong order either fails halfway, leaving the
-- database in a state nobody planned, or cascades further than intended. The
-- order below is child-first, and each block says what it is protecting
-- against.
--
-- THE ONE THING THIS SCRIPT CANNOT DO
-- It cannot delete the demo USER rows while `audit_events` references them,
-- because `audit_events.actor_user_id` is ON DELETE SET NULL, which is an
-- UPDATE, and script 08's trigger refuses every UPDATE. So the demo users are
-- SUSPENDED and their credentials removed rather than deleted. That is the
-- right outcome anyway: a deleted user takes the meaning out of every audit
-- row about them, and "who did this" becomes "somebody". A suspended user
-- with no credential cannot sign in, which is the property that matters.
--
-- SAFE TO RUN TWICE? Yes, in the sense that a second run deletes nothing more
-- and fails nothing. Not in the sense that it is ever a good idea.
-- NO TRANSACTION KEYWORDS.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- STEP 0. LOOK BEFORE YOU DELETE. Run this block ALONE, first, and read it.
-- If any count surprises you, stop and find out why before going further.
-- ---------------------------------------------------------------------------

SELECT 'accounts to delete' AS what, COUNT(*) AS n FROM accounts WHERE account_id LIKE 'ACC-0%'
UNION ALL SELECT 'contacts', COUNT(*) FROM contacts WHERE account_id LIKE 'ACC-0%'
UNION ALL SELECT 'leads', COUNT(*) FROM leads WHERE lead_id LIKE 'LEAD-0%'
UNION ALL SELECT 'opportunities', COUNT(*) FROM opportunities WHERE opportunity_id LIKE 'OPP-0%'
UNION ALL SELECT 'service cases', COUNT(*) FROM service_cases WHERE case_id LIKE 'CASE-0%'
UNION ALL SELECT 'sales orders', COUNT(*) FROM sales_orders WHERE sales_order_id LIKE 'SO-%'
UNION ALL SELECT 'purchase orders', COUNT(*) FROM purchase_orders WHERE purchase_order_id LIKE 'PO-%'
UNION ALL SELECT 'external users to suspend', COUNT(*) FROM users WHERE user_type = 'EXTERNAL'
UNION ALL SELECT 'internal demo users to suspend', COUNT(*) FROM users WHERE user_id LIKE 'USR-%'
UNION ALL SELECT 'audit rows (NONE are deleted)', COUNT(*) FROM audit_events;

-- ---------------------------------------------------------------------------
-- STEP 1. The portal. External access goes first, so that nothing below can
-- be visible to an outside party while the rest is being removed.
-- ---------------------------------------------------------------------------

DELETE FROM survey_invitations;
DELETE FROM survey_responses;
DELETE FROM customer_portal_memberships;

-- Their credentials, so no demo external user can sign in from this moment,
-- whatever else the script does or fails to do below.
DELETE FROM auth_credentials
 WHERE user_id IN (SELECT user_id FROM users WHERE user_type = 'EXTERNAL');
DELETE FROM sessions
 WHERE user_id IN (SELECT user_id FROM users WHERE user_type = 'EXTERNAL');

-- ---------------------------------------------------------------------------
-- STEP 2. Service. Children before parents: communications and histories
-- reference the case, and the SLA instances reference both.
-- ---------------------------------------------------------------------------

DELETE FROM sla_breaches WHERE entity_type IN ('CASE','SERVICE_CASE','LEAD','SALES_ORDER','PURCHASE_ORDER');
DELETE FROM sla_events;
DELETE FROM sla_instances;
DELETE FROM case_communications;
DELETE FROM case_assignment_history;
DELETE FROM case_status_history;
DELETE FROM service_cases;

-- ---------------------------------------------------------------------------
-- STEP 3. CRM.
-- ---------------------------------------------------------------------------

DELETE FROM activities;
DELETE FROM opportunity_products;
DELETE FROM opportunity_stage_history;
DELETE FROM opportunities;
DELETE FROM lead_qualifications;
DELETE FROM leads;

-- ---------------------------------------------------------------------------
-- STEP 4. Orders, workflow instances and everything the importers wrote.
--
-- `record_snapshots` and `import_rows` are the audit trail of the imports and
-- are removed with the imports themselves. They are not `audit_events`.
-- ---------------------------------------------------------------------------

DELETE FROM workflow_stage_instances;
DELETE FROM workflow_instances;
DELETE FROM sales_order_lines;
DELETE FROM sales_orders;
DELETE FROM purchase_order_lines;
DELETE FROM purchase_orders;
DELETE FROM record_snapshots;
DELETE FROM import_rows;
DELETE FROM unresolved_actors;
DELETE FROM import_batches;
DELETE FROM file_objects;
DELETE FROM source_identities;

-- ---------------------------------------------------------------------------
-- STEP 5. Customers and their attachments.
-- ---------------------------------------------------------------------------

DELETE FROM entity_attachments;
DELETE FROM contacts;
DELETE FROM accounts;

-- ---------------------------------------------------------------------------
-- STEP 6. Notifications, which reference everything above.
-- ---------------------------------------------------------------------------

DELETE FROM notifications;

-- ---------------------------------------------------------------------------
-- STEP 7. The demo users.
--
-- SUSPENDED AND STRIPPED, NOT DELETED, for the reason at the top: their audit
-- rows must keep their subject, and script 08's triggers refuse the cascade
-- that deleting them would attempt.
--
-- The email is left alone. Rewriting it would break the audit trail's link to
-- a real person for anybody investigating a historical event, and the account
-- cannot be signed in to anyway once the credential is gone.
-- ---------------------------------------------------------------------------

DELETE FROM auth_credentials WHERE user_id LIKE 'USR-%';
DELETE FROM sessions WHERE user_id LIKE 'USR-%';
DELETE FROM mfa_methods WHERE user_id LIKE 'USR-%';
DELETE FROM verification_tokens WHERE user_id LIKE 'USR-%';
DELETE FROM login_attempts WHERE user_id LIKE 'USR-%';

UPDATE users SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP
 WHERE user_id LIKE 'USR-%';

-- Their role and workflow-role assignments are deactivated rather than
-- deleted, so the configuration history stays readable.
UPDATE user_roles SET active = 0 WHERE user_id LIKE 'USR-%';
UPDATE workflow_role_assignments SET active = 0 WHERE user_id LIKE 'USR-%';
UPDATE user_assignments SET active = 0 WHERE user_id LIKE 'USR-%';

-- ---------------------------------------------------------------------------
-- VERIFICATION. Every row must read 0 except the last two.
-- ---------------------------------------------------------------------------

SELECT 'accounts' AS what, COUNT(*) AS must_be_zero FROM accounts
UNION ALL SELECT 'contacts', COUNT(*) FROM contacts
UNION ALL SELECT 'leads', COUNT(*) FROM leads
UNION ALL SELECT 'opportunities', COUNT(*) FROM opportunities
UNION ALL SELECT 'service cases', COUNT(*) FROM service_cases
UNION ALL SELECT 'sales orders', COUNT(*) FROM sales_orders
UNION ALL SELECT 'purchase orders', COUNT(*) FROM purchase_orders
UNION ALL SELECT 'portal memberships', COUNT(*) FROM customer_portal_memberships
UNION ALL SELECT 'credentials on demo users', COUNT(*) FROM auth_credentials WHERE user_id LIKE 'USR-%'
UNION ALL SELECT 'ACTIVE demo users (must be zero)', COUNT(*) FROM users WHERE user_id LIKE 'USR-%' AND status = 'ACTIVE'
UNION ALL SELECT 'roles kept (must NOT be zero)', COUNT(*) FROM access_roles
UNION ALL SELECT 'audit rows kept (must NOT be zero)', COUNT(*) FROM audit_events;

-- ---------------------------------------------------------------------------
-- AFTER THIS SCRIPT
--
-- The database has configuration and no data. Nobody can sign in, because
-- every seeded credential is gone. Create the first real administrator with:
--
--   pnpm db:cms:bootstrap-admin
--
-- and then create the real users through Administration, so that every one of
-- them is created by a named person and the audit trail says so.
-- ---------------------------------------------------------------------------
