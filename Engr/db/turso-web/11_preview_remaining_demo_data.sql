-- Preview remaining tenant/demo data before the full live-environment reset.
-- This query changes nothing.
SELECT 'users_total' AS item, COUNT(*) AS rows FROM users
UNION ALL SELECT 'approved_users_found', COUNT(*) FROM users
 WHERE deleted_at IS NULL AND lower(trim(email)) IN (
  'paul.mweki@hasspetroleum.com', 'scaver.rayasi@hasspetroleum.com',
  'wickliffe.opiyo@hasspetroleum.com', 'wilberforce.murikah@hasspetroleum.com',
  'kennedy.masoni@hasspetroleum.com', 'jeff.obuo@hasspetroleum.com')
UNION ALL SELECT 'technicians', COUNT(*) FROM technicians
UNION ALL SELECT 'contractors', COUNT(*) FROM contractors
UNION ALL SELECT 'engineer_assignments', COUNT(*) FROM engineer_assignments
UNION ALL SELECT 'stations', COUNT(*) FROM stations
UNION ALL SELECT 'assets', COUNT(*) FROM assets
UNION ALL SELECT 'asset_categories', COUNT(*) FROM asset_categories
UNION ALL SELECT 'regions', COUNT(*) FROM regions
UNION ALL SELECT 'slas', COUNT(*) FROM slas
UNION ALL SELECT 'pm_schedules', COUNT(*) FROM pm_schedules
UNION ALL SELECT 'pm_occurrences', COUNT(*) FROM pm_occurrences
UNION ALL SELECT 'requests', COUNT(*) FROM service_requests
UNION ALL SELECT 'rfqs', COUNT(*) FROM rfqs
UNION ALL SELECT 'quotes', COUNT(*) FROM quotes
UNION ALL SELECT 'lpos', COUNT(*) FROM lpos
UNION ALL SELECT 'work_orders', COUNT(*) FROM work_orders
UNION ALL SELECT 'work_costs', COUNT(*) FROM work_costs
UNION ALL SELECT 'bills', COUNT(*) FROM bills
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
UNION ALL SELECT 'notifications', COUNT(*) FROM notifications
UNION ALL SELECT 'organisations', COUNT(*) FROM organisations
ORDER BY item;
