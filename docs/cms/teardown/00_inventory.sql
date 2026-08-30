-- ============================================================================
-- 00_inventory.sql  -  confirm the target before destroying anything
-- ============================================================================
-- Run this FIRST, in the Turso web console, against the database that
-- TURSO_CMS_DATABASE_URL points at. Read the output and satisfy yourself that
-- this is the CMS database and not Engineering Rhythm's, the GRC platform's
-- (hassaudit) or the marketing site's. If you see `work_papers`, `action_plans`
-- or `organizations`, you are on the GRC database: STOP. If you see
-- `work_orders`, `rfqs` or `job_cards`, you are on the Engineering Rhythm
-- database: STOP. If you see `leads`, `subscribers` or `demo_sessions`, you are
-- on the marketing database: STOP.
--
-- The CMS database is the one whose objects are the list in
-- 01_dump_schema_note.md: customers, contacts, tickets, orders, invoices and so
-- on. Nothing here writes. Re-run it as often as you like.
-- ============================================================================

-- Every object, grouped by kind. This is also the proof query at the end of
-- 02_drop_all.sql; after the drop it must return no rows.
SELECT type, name, tbl_name
FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '\_litestream%' ESCAPE '\'
ORDER BY
  CASE type WHEN 'trigger' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END,
  name;

-- A count per kind, for a quick read of the size of the job.
SELECT type, COUNT(*) AS object_count
FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '\_litestream%' ESCAPE '\'
GROUP BY type
ORDER BY type;

-- Row counts for the tables that carry the customer data, so the scale of what
-- is about to be destroyed is on the screen before it goes. Each is wrapped so
-- a table that is already absent does not stop the batch.
SELECT 'customers' AS table_name, COUNT(*) AS rows FROM customers
UNION ALL SELECT 'contacts',  COUNT(*) FROM contacts
UNION ALL SELECT 'orders',    COUNT(*) FROM orders
UNION ALL SELECT 'invoices',  COUNT(*) FROM invoices
UNION ALL SELECT 'tickets',   COUNT(*) FROM tickets
UNION ALL SELECT 'users',     COUNT(*) FROM users
UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log;
