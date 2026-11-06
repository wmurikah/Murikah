-- DESTRUCTIVE full demo-data reset for Engineering Rhythm.
-- Retains only the six approved users and the platform/tenant configuration
-- required for them to authenticate. Run 11_preview_remaining_demo_data.sql first.
--
-- Drizzle Studio supplies the transaction. Do not add BEGIN or COMMIT.

DROP TABLE IF EXISTS _maintenance_live_reset_guard;
CREATE TABLE _maintenance_live_reset_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Abort and roll back the entire batch unless all six approved users exist.
INSERT INTO _maintenance_live_reset_guard (ok)
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

-- Polymorphic tenant data has no foreign keys to its source records.
DELETE FROM attachments;
DELETE FROM notifications;

-- Payments and billing depend on work costs.
DELETE FROM payments;
DELETE FROM bill_approvals;
DELETE FROM bill_costs;
DELETE FROM bills;

-- Costing depends on work orders and quotes.
DELETE FROM cost_approvals;
DELETE FROM work_cost_items;
DELETE FROM work_costs;

-- Work execution details.
DELETE FROM job_card_spares;
DELETE FROM job_cards;
DELETE FROM job_safety_analyses;
DELETE FROM site_arrivals;
DELETE FROM pm_checklist_results;
DELETE FROM mileage_claims;
DELETE FROM lpo_lines;
DELETE FROM work_orders;
DELETE FROM lpos;

-- Procurement and source requests.
DELETE FROM quote_items;
DELETE FROM quotes;
DELETE FROM rfq_invitations;
DELETE FROM rfqs;
DELETE FROM service_requests;

-- Preventive-maintenance tenant data. Platform code and schema remain.
DELETE FROM pm_occurrences;
DELETE FROM pm_schedules;
DELETE FROM pm_checklist_items;
DELETE FROM pm_checklist_templates;

-- Remove every technician and all contractor-side master data.
DELETE FROM technicians;
DELETE FROM rate_items;
DELETE FROM rate_cards;
DELETE FROM contractor_categories;
DELETE FROM contractor_stations;
DELETE FROM contractors;

-- Remove engineering demo assignments and physical-site master data.
DELETE FROM engineer_assignments;
DELETE FROM assets;
DELETE FROM stations;
DELETE FROM asset_categories;
DELETE FROM regions;
DELETE FROM slas;

-- Record the user deletion before removing the accounts. Wilberforce remains
-- the audit actor. Passwords and tokens are never included in audit JSON.
INSERT INTO audit_logs
  (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
SELECT
  users.org_id,
  (SELECT id FROM users
    WHERE lower(trim(email)) = 'wilberforce.murikah@hasspetroleum.com'
      AND deleted_at IS NULL
    LIMIT 1),
  'users.live_reset_delete',
  'user',
  users.id,
  json_object('full_name', users.full_name, 'email', users.email, 'status', users.status),
  json_object('deleted', 1, 'sessions_revoked', 1, 'live_environment_reset', 1)
FROM users
WHERE lower(trim(users.email)) NOT IN (
  'paul.mweki@hasspetroleum.com',
  'scaver.rayasi@hasspetroleum.com',
  'wickliffe.opiyo@hasspetroleum.com',
  'wilberforce.murikah@hasspetroleum.com',
  'kennedy.masoni@hasspetroleum.com',
  'jeff.obuo@hasspetroleum.com'
);

-- Cascades delete role assignments, sessions, tokens, MFA records and engineer
-- assignments for every removed account. SET NULL relationships preserve audit.
DELETE FROM users
WHERE lower(trim(email)) NOT IN (
  'paul.mweki@hasspetroleum.com',
  'scaver.rayasi@hasspetroleum.com',
  'wickliffe.opiyo@hasspetroleum.com',
  'wilberforce.murikah@hasspetroleum.com',
  'kennedy.masoni@hasspetroleum.com',
  'jeff.obuo@hasspetroleum.com'
);

-- Remove authentication telemetry that no longer belongs to a retained user.
DELETE FROM auth_login_events
WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users);
DELETE FROM auth_login_limits;

-- Retain audit records only when their actor is one of the approved accounts.
-- Cleanup audit entries use Wilberforce as their retained actor.
DELETE FROM audit_logs
WHERE actor_user_id IS NULL OR actor_user_id NOT IN (SELECT id FROM users);

-- Keep organisations containing an approved user and all their ancestors.
-- Unrelated/demo organisations cascade-delete their settings, roles and billing.
WITH RECURSIVE retained_organisations(id) AS (
  SELECT DISTINCT org_id FROM users
  UNION
  SELECT organisations.parent_org_id
  FROM organisations
  JOIN retained_organisations ON organisations.id = retained_organisations.id
  WHERE organisations.parent_org_id IS NOT NULL
)
DELETE FROM organisations
WHERE id NOT IN (SELECT id FROM retained_organisations);

DROP TABLE _maintenance_live_reset_guard;

-- Expected: six users and zero rows for every tenant/demo data count.
SELECT
  (SELECT COUNT(*) FROM users) AS users_remaining,
  (SELECT COUNT(*) FROM technicians) AS technicians_remaining,
  (SELECT COUNT(*) FROM contractors) AS contractors_remaining,
  (SELECT COUNT(*) FROM engineer_assignments) AS assignments_remaining,
  (SELECT COUNT(*) FROM stations) AS stations_remaining,
  (SELECT COUNT(*) FROM assets) AS assets_remaining,
  (SELECT COUNT(*) FROM asset_categories) AS categories_remaining,
  (SELECT COUNT(*) FROM regions) AS regions_remaining,
  (SELECT COUNT(*) FROM slas) AS slas_remaining,
  (SELECT COUNT(*) FROM pm_schedules) AS pm_schedules_remaining,
  (SELECT COUNT(*) FROM service_requests) AS requests_remaining,
  (SELECT COUNT(*) FROM rfqs) AS rfqs_remaining,
  (SELECT COUNT(*) FROM lpos) AS lpos_remaining,
  (SELECT COUNT(*) FROM work_orders) AS work_orders_remaining,
  (SELECT COUNT(*) FROM attachments) AS attachments_remaining,
  (SELECT COUNT(*) FROM notifications) AS notifications_remaining;
