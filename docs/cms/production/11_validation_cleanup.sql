-- ###########################################################################
-- #                                                                         #
-- #   THIS SCRIPT DELETES DATA. READ IT BEFORE YOU RUN IT.                   #
-- #                                                                         #
-- #   IT HAS NOT BEEN RUN BY ANYBODY. Build Prompt 30 wrote it and did not   #
-- #   execute it. The build environment holds no credential for any live     #
-- #   database and running SQL against one is a stop condition for the       #
-- #   phase that wrote this. Nothing below has been executed against a       #
-- #   real database; it has been read, ordered and reasoned about, and       #
-- #   that is a different thing from being tested.                           #
-- #                                                                         #
-- ###########################################################################
--
-- CMS Build Prompt 30: removal of the end-to-end validation dataset.
--
-- WHY THIS FILE EXISTS
-- The phase 30 validation suite (`test/cms/endToEnd.test.ts`) normally runs
-- against a throwaway in-memory database that is created and discarded per
-- test, so on a normal run there is nothing to clean up and this script has
-- no work to do. It exists for the other case: an operator or an auditor
-- replaying those journeys by hand against a staging database, or against a
-- restored copy of production, to satisfy themselves that the system behaves
-- as the report says. Records made that way are real rows in a real database
-- and somebody has to take them out again.
--
-- HOW THE VALIDATION RECORDS ARE FOUND
-- Every record the suite creates is labelled twice, on purpose, so that a
-- rename does not orphan it:
--
--   * a NAME, SUBJECT or TITLE beginning `VALIDATION-`
--   * a CODE beginning `E2E-`
--
-- This script finds them by BOTH and takes the union. If you replayed the
-- journeys by hand and did not use those prefixes, this script will not find
-- your records and you must remove them yourself. That is the correct
-- behaviour: a cleanup script that guesses at what is test data is more
-- dangerous than no cleanup script at all.
--
-- WHAT IT WILL NOT DO
--   * It deletes NO historical production record. Every DELETE below is
--     restricted to the labelled set through the temporary tables in step 1,
--     and step 0 makes you look at that set before anything is removed.
--   * It deletes NO row from `audit_events`. After
--     `docs/cms/audit/08_audit_immutability.sql` it could not: the triggers
--     refuse every UPDATE and every DELETE. The audit trail of the validation
--     run therefore SURVIVES this script, which is the right outcome. The
--     evidence that a person tested the system is itself evidence.
--   * It deletes no user, no role, no permission, no workflow, no SLA rule,
--     no calendar and no product. The suite creates none of those.
--
-- THE EXTERNAL CREDENTIAL RULE
-- Step 7 is not optional and is not about the labelled set. If the journeys
-- were replayed against a database that carries portal users, no test
-- external credential may be left able to sign in afterwards. Step 7 revokes
-- sessions, removes credentials and suspends the account for every EXTERNAL
-- user carrying a validation label or a demo address. Read its WHERE clause
-- and satisfy yourself it names nobody real before you run it.
--
-- BEFORE YOU RUN IT
--   1. Confirm the target. `docs/cms/teardown/00_inventory.sql` prints the
--      object list; if you see `work_papers`, `work_orders` or `subscribers`
--      you are on the wrong database and must STOP.
--   2. Run step 0 and read the counts. If a number surprises you, stop and
--      find out why before deleting anything.
--   3. Take a backup and test its restore. Not "a backup exists": a restore
--      has been tested.
--   4. Run steps 1 to 8 IN ORDER, in ONE console session. The temporary
--      tables step 1 creates live for that session and every later step reads
--      them, so a session that is closed and reopened halfway through has
--      lost them and step 2 onwards will delete nothing.
--   5. Run step 9 and confirm every count is zero.
--
-- NO TRANSACTION KEYWORDS, for the same reason as
-- `10_production_cleanup.sql`: the Turso web console runs a statement at a
-- time and cannot hold a transaction open across them, so a `BEGIN` here
-- would be a comforting word that does nothing. The consequence is real and
-- you should know it before you start: a statement that fails halfway leaves
-- the earlier deletions applied. That is what the tested restore in point 3
-- is for, and it is why step 9 checks rather than assumes.
--
-- ============================================================================


-- ============================================================================
-- STEP 0  -  LOOK AT WHAT YOU ARE ABOUT TO DELETE. This step writes nothing.
--            Run it on its own, read the output, and only continue if every
--            line is a record you recognise as a validation artefact.
-- ============================================================================

SELECT 'accounts' AS table_name, account_id AS id, account_name AS label
FROM accounts
WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%'
UNION ALL
SELECT 'contacts', contact_id, full_name
FROM contacts
WHERE full_name LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM accounts
                     WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%')
UNION ALL
SELECT 'leads', lead_id, title
FROM leads
WHERE title LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM accounts
                     WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%')
UNION ALL
SELECT 'opportunities', opportunity_id, title
FROM opportunities
WHERE title LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM accounts
                     WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%')
UNION ALL
SELECT 'service_cases', case_id, subject
FROM service_cases
WHERE subject LIKE 'VALIDATION-%'
UNION ALL
SELECT 'sales_orders', sales_order_id, document_number
FROM sales_orders
WHERE document_number LIKE 'E2E-%'
UNION ALL
SELECT 'purchase_orders', purchase_order_id, document_number
FROM purchase_orders
WHERE document_number LIKE 'E2E-%'
ORDER BY table_name, id;

-- The same thing as counts, for the record. Write these down: step 9 checks
-- them back to zero.
SELECT 'accounts' AS table_name,
       COUNT(*) AS labelled_rows
FROM accounts WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%'
UNION ALL SELECT 'contacts', COUNT(*) FROM contacts WHERE full_name LIKE 'VALIDATION-%'
UNION ALL SELECT 'leads', COUNT(*) FROM leads WHERE title LIKE 'VALIDATION-%'
UNION ALL SELECT 'opportunities', COUNT(*) FROM opportunities WHERE title LIKE 'VALIDATION-%'
UNION ALL SELECT 'service_cases', COUNT(*) FROM service_cases WHERE subject LIKE 'VALIDATION-%'
UNION ALL SELECT 'sales_orders', COUNT(*) FROM sales_orders WHERE document_number LIKE 'E2E-%'
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders WHERE document_number LIKE 'E2E-%';


-- ============================================================================
-- FROM HERE ON, EVERYTHING WRITES. Run steps 1 to 8 in order, one session.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- STEP 1  -  Freeze the target set.
--
-- The identifiers are captured ONCE, into temporary tables, and every DELETE
-- below reads from those tables rather than re-evaluating the LIKE patterns.
-- This matters: without it, a DELETE that clears a name would change what a
-- later DELETE matches, and the script would leave a partial mess behind. It
-- also means that if you edit a pattern, you edit it in exactly one place.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE v_accounts AS
SELECT account_id
FROM accounts
WHERE account_name LIKE 'VALIDATION-%'
   OR account_code LIKE 'E2E-%';

CREATE TEMP TABLE v_contacts AS
SELECT contact_id
FROM contacts
WHERE full_name LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM v_accounts);

CREATE TEMP TABLE v_leads AS
SELECT lead_id
FROM leads
WHERE title LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM v_accounts);

CREATE TEMP TABLE v_opportunities AS
SELECT opportunity_id
FROM opportunities
WHERE title LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM v_accounts)
   OR lead_id IN (SELECT lead_id FROM v_leads);

CREATE TEMP TABLE v_cases AS
SELECT case_id
FROM service_cases
WHERE subject LIKE 'VALIDATION-%'
   OR account_id IN (SELECT account_id FROM v_accounts);

CREATE TEMP TABLE v_sales_orders AS
SELECT sales_order_id
FROM sales_orders
WHERE document_number LIKE 'E2E-%'
   OR account_id IN (SELECT account_id FROM v_accounts);

CREATE TEMP TABLE v_purchase_orders AS
SELECT purchase_order_id
FROM purchase_orders
WHERE document_number LIKE 'E2E-%';

-- The SLA instances raised for those records. `sla_instances` is polymorphic:
-- it names the entity by type and identifier rather than by a foreign key, so
-- there is no cascade to rely on and this has to be explicit.
CREATE TEMP TABLE v_sla_instances AS
SELECT sla_instance_id
FROM sla_instances
WHERE (entity_type = 'SERVICE_CASE' AND entity_id IN (SELECT case_id FROM v_cases))
   OR (entity_type = 'SALES_ORDER' AND entity_id IN (SELECT sales_order_id FROM v_sales_orders))
   OR (entity_type = 'PURCHASE_ORDER'
       AND entity_id IN (SELECT purchase_order_id FROM v_purchase_orders));


-- ----------------------------------------------------------------------------
-- STEP 2  -  The polymorphic children, which no cascade will reach.
--
-- `activities`, `entity_attachments`, `notifications` and `record_snapshots`
-- all address their subject by type and identifier. Deleting the subject
-- leaves them behind as orphans that the integrity check in
-- `test/cms/endToEnd.test.ts` §9 would then report. They go first.
-- ----------------------------------------------------------------------------

DELETE FROM activities
WHERE (entity_type = 'LEAD' AND entity_id IN (SELECT lead_id FROM v_leads))
   OR (entity_type = 'OPPORTUNITY'
       AND entity_id IN (SELECT opportunity_id FROM v_opportunities))
   OR (entity_type = 'SERVICE_CASE' AND entity_id IN (SELECT case_id FROM v_cases))
   OR (entity_type = 'ACCOUNT' AND entity_id IN (SELECT account_id FROM v_accounts))
   OR (entity_type = 'CONTACT' AND entity_id IN (SELECT contact_id FROM v_contacts));

DELETE FROM entity_attachments
WHERE (entity_type = 'SERVICE_CASE' AND entity_id IN (SELECT case_id FROM v_cases))
   OR (entity_type = 'ACCOUNT' AND entity_id IN (SELECT account_id FROM v_accounts))
   OR (entity_type = 'OPPORTUNITY'
       AND entity_id IN (SELECT opportunity_id FROM v_opportunities))
   OR (entity_type = 'SALES_ORDER'
       AND entity_id IN (SELECT sales_order_id FROM v_sales_orders))
   OR (entity_type = 'PURCHASE_ORDER'
       AND entity_id IN (SELECT purchase_order_id FROM v_purchase_orders));

DELETE FROM notifications
WHERE (entity_type = 'SERVICE_CASE' AND entity_id IN (SELECT case_id FROM v_cases))
   OR (entity_type = 'LEAD' AND entity_id IN (SELECT lead_id FROM v_leads))
   OR (entity_type = 'OPPORTUNITY'
       AND entity_id IN (SELECT opportunity_id FROM v_opportunities))
   OR (entity_type = 'SALES_ORDER'
       AND entity_id IN (SELECT sales_order_id FROM v_sales_orders))
   OR (entity_type = 'PURCHASE_ORDER'
       AND entity_id IN (SELECT purchase_order_id FROM v_purchase_orders));

DELETE FROM record_snapshots
WHERE (entity_type = 'SALES_ORDER'
       AND entity_id IN (SELECT sales_order_id FROM v_sales_orders))
   OR (entity_type = 'PURCHASE_ORDER'
       AND entity_id IN (SELECT purchase_order_id FROM v_purchase_orders));


-- ----------------------------------------------------------------------------
-- STEP 3  -  The SLA record for those entities.
--
-- `sla_timer_events`, `sla_breaches` and `sla_escalation_events` all cascade
-- from `sla_instances`, so deleting the instance is enough. They are listed
-- here anyway, ahead of it, because relying on a cascade you have not read is
-- how a script deletes more than its author intended. If the cascade is
-- present these are no-ops; if it has been altered, they are the safeguard.
-- ----------------------------------------------------------------------------

DELETE FROM sla_escalation_events
WHERE sla_instance_id IN (SELECT sla_instance_id FROM v_sla_instances);

DELETE FROM sla_breaches
WHERE sla_instance_id IN (SELECT sla_instance_id FROM v_sla_instances);

DELETE FROM sla_timer_events
WHERE sla_instance_id IN (SELECT sla_instance_id FROM v_sla_instances);

DELETE FROM sla_instances
WHERE sla_instance_id IN (SELECT sla_instance_id FROM v_sla_instances);


-- ----------------------------------------------------------------------------
-- STEP 4  -  Service: the survey record first, then the case and its children.
--
-- `survey_responses.case_id` is ON DELETE SET NULL, which would leave a
-- response floating with no case and a satisfaction figure that no longer has
-- anything behind it. A validation response is not a customer's opinion and
-- must not survive into a satisfaction average, so it is deleted rather than
-- detached. `survey_invitations`, `case_communications`,
-- `case_status_history` and `case_assignment_history` all cascade from the
-- case; they are named for the same reason as step 3.
-- ----------------------------------------------------------------------------

DELETE FROM survey_invitations
WHERE case_id IN (SELECT case_id FROM v_cases)
   OR account_id IN (SELECT account_id FROM v_accounts);

DELETE FROM survey_responses
WHERE case_id IN (SELECT case_id FROM v_cases)
   OR account_id IN (SELECT account_id FROM v_accounts);

DELETE FROM case_communications WHERE case_id IN (SELECT case_id FROM v_cases);
DELETE FROM case_status_history WHERE case_id IN (SELECT case_id FROM v_cases);
DELETE FROM case_assignment_history WHERE case_id IN (SELECT case_id FROM v_cases);
DELETE FROM service_cases WHERE case_id IN (SELECT case_id FROM v_cases);


-- ----------------------------------------------------------------------------
-- STEP 5  -  The order documents.
--
-- Lines cascade from their header. The headers carry `latest_snapshot_id`,
-- whose snapshot rows went in step 2; if that constraint is RESTRICT rather
-- than SET NULL on your database, clear the pointer first with the UPDATE
-- below, which is commented out because on the shipped schema it is not
-- needed and an unnecessary UPDATE is an unnecessary risk.
--
--   UPDATE sales_orders SET latest_snapshot_id = NULL
--   WHERE sales_order_id IN (SELECT sales_order_id FROM v_sales_orders);
-- ----------------------------------------------------------------------------

DELETE FROM sales_order_lines
WHERE sales_order_id IN (SELECT sales_order_id FROM v_sales_orders);

DELETE FROM sales_orders
WHERE sales_order_id IN (SELECT sales_order_id FROM v_sales_orders);

DELETE FROM purchase_order_lines
WHERE purchase_order_id IN (SELECT purchase_order_id FROM v_purchase_orders);

DELETE FROM purchase_orders
WHERE purchase_order_id IN (SELECT purchase_order_id FROM v_purchase_orders);


-- ----------------------------------------------------------------------------
-- STEP 6  -  CRM: opportunity, then lead, then contact, then account.
--
-- Strictly child first. `opportunities.account_id` is ON DELETE RESTRICT, so
-- the account cannot go until its opportunities have; `leads.account_id` is
-- ON DELETE SET NULL, which would silently detach a validation lead from a
-- deleted validation account and leave it in the funnel denominator, so the
-- leads are deleted rather than left to the cascade. `contacts` cascades from
-- the account, and is named here for the reason given in step 3.
-- ----------------------------------------------------------------------------

DELETE FROM opportunity_stage_history
WHERE opportunity_id IN (SELECT opportunity_id FROM v_opportunities);

DELETE FROM opportunity_products
WHERE opportunity_id IN (SELECT opportunity_id FROM v_opportunities);

DELETE FROM opportunities
WHERE opportunity_id IN (SELECT opportunity_id FROM v_opportunities);

DELETE FROM lead_qualifications WHERE lead_id IN (SELECT lead_id FROM v_leads);
DELETE FROM leads WHERE lead_id IN (SELECT lead_id FROM v_leads);

DELETE FROM customer_portal_memberships
WHERE account_id IN (SELECT account_id FROM v_accounts)
   OR contact_id IN (SELECT contact_id FROM v_contacts);

DELETE FROM contacts WHERE contact_id IN (SELECT contact_id FROM v_contacts);
DELETE FROM accounts WHERE account_id IN (SELECT account_id FROM v_accounts);


-- ----------------------------------------------------------------------------
-- STEP 7  -  NO TEST EXTERNAL CREDENTIAL IS LEFT ACTIVE.
--
-- This step is not about the labelled set and is not optional. An external
-- user who can still sign in is the one outcome of a validation run that
-- reaches a customer, and no amount of deleted rows compensates for it.
--
-- The users are NOT deleted. `audit_events.actor_user_id` is ON DELETE SET
-- NULL, which is an UPDATE, and script 08's trigger refuses every UPDATE of
-- an audit row, so the delete would fail. It would also be the wrong thing:
-- a deleted actor turns every audit row about them into "somebody". They are
-- SUSPENDED with no credential and no session, which is the property that
-- actually matters.
--
-- READ THIS WHERE CLAUSE BEFORE RUNNING IT and satisfy yourself that it names
-- nobody real. It matches EXTERNAL users only, and within those only the ones
-- carrying a validation label or one of the demo domains.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE v_external_users AS
SELECT user_id
FROM users
WHERE user_type = 'EXTERNAL'
  AND (
        display_name LIKE 'VALIDATION-%'
     OR first_name LIKE 'VALIDATION-%'
     OR email LIKE 'validation%'
     OR email LIKE '%@example.com'
     OR email LIKE '%@example.co.ke'
     OR email LIKE '%@test.invalid'
  );

-- Every way in, closed. Sessions first, so that a credential removed a
-- moment later cannot be used by a session that is still open.
UPDATE auth_sessions
SET status = 'REVOKED',
    revoked_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE user_id IN (SELECT user_id FROM v_external_users)
  AND status = 'ACTIVE';

DELETE FROM auth_credentials WHERE user_id IN (SELECT user_id FROM v_external_users);
DELETE FROM mfa_methods WHERE user_id IN (SELECT user_id FROM v_external_users);
DELETE FROM password_reset_tokens WHERE user_id IN (SELECT user_id FROM v_external_users);
DELETE FROM email_verification_tokens WHERE user_id IN (SELECT user_id FROM v_external_users);
DELETE FROM source_identities WHERE user_id IN (SELECT user_id FROM v_external_users);

-- The portal memberships go too: a suspended user with a live membership
-- still appears on the account's portal access list, which reads as a person
-- who has access.
DELETE FROM customer_portal_memberships
WHERE user_id IN (SELECT user_id FROM v_external_users);

UPDATE users
SET status = 'SUSPENDED',
    updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE user_id IN (SELECT user_id FROM v_external_users)
  AND status <> 'SUSPENDED';


-- ----------------------------------------------------------------------------
-- STEP 8  -  Drop the temporary tables.
--
-- They are session scoped and would go on their own when the console session
-- ends, but leaving them named means a second run in the same session would
-- fail on `CREATE TEMP TABLE` and the operator would be reading an error
-- about a table name instead of about their data.
-- ----------------------------------------------------------------------------

DROP TABLE v_sla_instances;
DROP TABLE v_purchase_orders;
DROP TABLE v_sales_orders;
DROP TABLE v_cases;
DROP TABLE v_opportunities;
DROP TABLE v_leads;
DROP TABLE v_contacts;
DROP TABLE v_accounts;
DROP TABLE v_external_users;


-- ============================================================================
-- STEP 9  -  VERIFY. Every count below must be zero. Run it after step 8.
--            If any count is not zero, the script did not do what it says and
--            you must find out why before treating the cleanup as done.
-- ============================================================================

SELECT 'labelled accounts remaining' AS check_name, COUNT(*) AS must_be_zero
FROM accounts WHERE account_name LIKE 'VALIDATION-%' OR account_code LIKE 'E2E-%'
UNION ALL
SELECT 'labelled contacts remaining', COUNT(*)
FROM contacts WHERE full_name LIKE 'VALIDATION-%'
UNION ALL
SELECT 'labelled leads remaining', COUNT(*)
FROM leads WHERE title LIKE 'VALIDATION-%'
UNION ALL
SELECT 'labelled opportunities remaining', COUNT(*)
FROM opportunities WHERE title LIKE 'VALIDATION-%'
UNION ALL
SELECT 'labelled cases remaining', COUNT(*)
FROM service_cases WHERE subject LIKE 'VALIDATION-%'
UNION ALL
SELECT 'labelled sales orders remaining', COUNT(*)
FROM sales_orders WHERE document_number LIKE 'E2E-%'
UNION ALL
SELECT 'labelled purchase orders remaining', COUNT(*)
FROM purchase_orders WHERE document_number LIKE 'E2E-%'
UNION ALL
-- Orphans. A cleanup that deletes a parent and leaves its polymorphic
-- children is worse than one that deletes nothing, because the integrity
-- report then carries a finding that nobody can trace to a cause.
SELECT 'orphaned activities', COUNT(*)
FROM activities a
WHERE (a.entity_type = 'LEAD' AND NOT EXISTS
        (SELECT 1 FROM leads l WHERE l.lead_id = a.entity_id))
   OR (a.entity_type = 'OPPORTUNITY' AND NOT EXISTS
        (SELECT 1 FROM opportunities o WHERE o.opportunity_id = a.entity_id))
   OR (a.entity_type = 'SERVICE_CASE' AND NOT EXISTS
        (SELECT 1 FROM service_cases s WHERE s.case_id = a.entity_id))
UNION ALL
SELECT 'orphaned SLA instances', COUNT(*)
FROM sla_instances i
WHERE i.entity_type = 'SERVICE_CASE'
  AND NOT EXISTS (SELECT 1 FROM service_cases s WHERE s.case_id = i.entity_id)
UNION ALL
-- The credential rule, checked rather than asserted.
SELECT 'test external users still able to sign in', COUNT(*)
FROM users u
WHERE u.user_type = 'EXTERNAL'
  AND u.status = 'ACTIVE'
  AND (u.display_name LIKE 'VALIDATION-%'
    OR u.email LIKE 'validation%'
    OR u.email LIKE '%@example.com'
    OR u.email LIKE '%@example.co.ke'
    OR u.email LIKE '%@test.invalid')
UNION ALL
SELECT 'test external credentials remaining', COUNT(*)
FROM auth_credentials cr
JOIN users u ON u.user_id = cr.user_id
WHERE u.user_type = 'EXTERNAL'
  AND (u.display_name LIKE 'VALIDATION-%'
    OR u.email LIKE 'validation%'
    OR u.email LIKE '%@example.com'
    OR u.email LIKE '%@example.co.ke'
    OR u.email LIKE '%@test.invalid')
UNION ALL
SELECT 'test external sessions still active', COUNT(*)
FROM auth_sessions s
JOIN users u ON u.user_id = s.user_id
WHERE u.user_type = 'EXTERNAL'
  AND s.status = 'ACTIVE'
  AND (u.display_name LIKE 'VALIDATION-%'
    OR u.email LIKE 'validation%'
    OR u.email LIKE '%@example.com'
    OR u.email LIKE '%@example.co.ke'
    OR u.email LIKE '%@test.invalid');

-- The audit trail of the validation run is expected to REMAIN. This is not a
-- failure and there is nothing to fix. It is stated as a positive count so
-- that a reader of the output is not left wondering whether it was missed.
SELECT 'audit rows about the validation run, deliberately kept' AS note,
       COUNT(*) AS rows_kept
FROM audit_events
WHERE entity_type IN ('ACCOUNT', 'CONTACT', 'LEAD', 'OPPORTUNITY', 'SERVICE_CASE')
  AND event_at >= date('now', '-7 day');
