-- DESTRUCTIVE clean-slate reset for Engineering Rhythm.
-- Run only after 09_preview_user_cleanup.sql shows exactly six KEEP rows:
-- Paul Mweki, Scaver Rayasi Dando, Wickliffe Opiyo, Wilberforce Murikah,
-- Kennedy Masoni, and Jeff Omondi Obuo.
--
-- This removes all requests, RFQs/quotes, LPOs, work orders and their dependent
-- costs, bills, payments, job records, mileage, PM occurrences, attachments and
-- notifications. It then physically deletes every user except the six approved
-- email addresses. Organisation/configuration master data remains.
--
-- Drizzle Studio supplies the transaction. Do not add BEGIN or COMMIT.

DROP TABLE IF EXISTS _maintenance_user_cleanup_guard;
CREATE TABLE _maintenance_user_cleanup_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Abort and roll back the whole batch if even one approved account is missing.
INSERT INTO _maintenance_user_cleanup_guard (ok)
SELECT CASE WHEN COUNT(DISTINCT lower(trim(users.email))) = 6 THEN 1 ELSE 0 END
FROM users
WHERE users.deleted_at IS NULL
  AND lower(trim(users.email)) IN (
    'paul.mweki@hasspetroleum.com',
    'scaver.rayasi@hasspetroleum.com',
    'wickliffe.opiyo@hasspetroleum.com',
    'wilberforce.murikah@hasspetroleum.com',
    'kennedy.masoni@hasspetroleum.com',
    'jeff.obuo@hasspetroleum.com'
  );

-- Remove unreferenced polymorphic records for the workflow data being reset.
DELETE FROM attachments
WHERE entity_type IN (
  'service_request', 'rfq', 'quote', 'lpo', 'work_order',
  'work_cost', 'bill', 'payment', 'job_card'
);

DELETE FROM notifications
WHERE entity_type IN (
  'service_request', 'rfq', 'quote', 'lpo', 'work_order',
  'work_cost', 'bill', 'payment', 'job_card'
);

-- Billing depends on costs, so it must be removed first.
DELETE FROM payments;
DELETE FROM bill_approvals;
DELETE FROM bill_costs;
DELETE FROM bills;

-- Costing depends on work orders and may reference quotes.
DELETE FROM cost_approvals;
DELETE FROM work_cost_items;
DELETE FROM work_costs;

-- Work-order execution records.
DELETE FROM job_card_spares;
DELETE FROM job_cards;
DELETE FROM job_safety_analyses;
DELETE FROM site_arrivals;
DELETE FROM pm_checklist_results;
DELETE FROM mileage_claims;

-- Expanded LPO lines use NO ACTION foreign keys, so remove them before either
-- LPOs or work orders.
DELETE FROM lpo_lines;

-- PM occurrences can point at generated work orders. Schedules/templates remain.
DELETE FROM pm_occurrences;

DELETE FROM work_orders;
DELETE FROM lpos;

-- RFQ documents and their source requests.
DELETE FROM quote_items;
DELETE FROM quotes;
DELETE FROM rfq_invitations;
DELETE FROM rfqs;
DELETE FROM service_requests;

-- Record exactly which user records are about to be removed. The actor is the
-- retained Owner account; no password or token is written to the audit log.
INSERT INTO audit_logs
  (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
SELECT
  users.org_id,
  (SELECT id FROM users
    WHERE lower(trim(email)) = 'wilberforce.murikah@hasspetroleum.com'
      AND deleted_at IS NULL
    LIMIT 1),
  'users.bulk_delete',
  'user',
  users.id,
  json_object('full_name', users.full_name, 'email', users.email, 'status', users.status),
  json_object('deleted', 1, 'sessions_revoked', 1, 'operational_reset', 1)
FROM users
WHERE lower(trim(users.email)) NOT IN (
  'paul.mweki@hasspetroleum.com',
  'scaver.rayasi@hasspetroleum.com',
  'wickliffe.opiyo@hasspetroleum.com',
  'wilberforce.murikah@hasspetroleum.com',
  'kennedy.masoni@hasspetroleum.com',
  'jeff.obuo@hasspetroleum.com'
);

-- Cascades remove sessions, tokens, MFA data, role assignments and engineer
-- assignments. SET NULL relationships preserve contractor/station history.
DELETE FROM users
WHERE lower(trim(email)) NOT IN (
  'paul.mweki@hasspetroleum.com',
  'scaver.rayasi@hasspetroleum.com',
  'wickliffe.opiyo@hasspetroleum.com',
  'wilberforce.murikah@hasspetroleum.com',
  'kennedy.masoni@hasspetroleum.com',
  'jeff.obuo@hasspetroleum.com'
);

DROP TABLE _maintenance_user_cleanup_guard;

-- Final verification. Expected: users_remaining = 6 and every other value = 0.
SELECT
  (SELECT COUNT(*) FROM users) AS users_remaining,
  (SELECT COUNT(*) FROM service_requests) AS requests_remaining,
  (SELECT COUNT(*) FROM rfqs) AS rfqs_remaining,
  (SELECT COUNT(*) FROM quotes) AS quotes_remaining,
  (SELECT COUNT(*) FROM lpos) AS lpos_remaining,
  (SELECT COUNT(*) FROM lpo_lines) AS lpo_lines_remaining,
  (SELECT COUNT(*) FROM work_orders) AS work_orders_remaining,
  (SELECT COUNT(*) FROM work_costs) AS costs_remaining,
  (SELECT COUNT(*) FROM bills) AS bills_remaining,
  (SELECT COUNT(*) FROM payments) AS payments_remaining;
