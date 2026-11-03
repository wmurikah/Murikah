-- Read-only pre/post-deployment evidence. No customer values or rows returned.
-- Run manually against hass-cms, not periodically from a health monitor.

-- Inspect ALL indexes on these tables, including UNIQUE/PRIMARY KEY indexes,
-- so an equivalent index with another name is visible before adding one.
SELECT 'notifications' AS table_name, name, "unique", origin, partial
FROM pragma_index_list('notifications')
UNION ALL
SELECT 'sla_instances', name, "unique", origin, partial
FROM pragma_index_list('sla_instances')
UNION ALL
SELECT 'sla_timer_events', name, "unique", origin, partial
FROM pragma_index_list('sla_timer_events');

SELECT name, tbl_name, sql FROM sqlite_schema
WHERE type='index' AND tbl_name IN ('notifications','sla_instances','sla_timer_events')
ORDER BY tbl_name,name;

-- These exact counts read the tables once. They can consume row-read quota on
-- a large database; run once when needed, not on every before/after plan check.
SELECT 'notifications' AS table_name, COUNT(*) AS row_count FROM notifications
UNION ALL SELECT 'sla_instances', COUNT(*) FROM sla_instances
UNION ALL SELECT 'sla_timer_events', COUNT(*) FROM sla_timer_events;

-- EXPLAIN QUERY PLAN compiles queries without retrieving matching records.
-- The synthetic identity values are plan probes, not real user identifiers.
EXPLAIN QUERY PLAN
SELECT COUNT(*) FROM notifications
WHERE user_id='__cms_plan_probe__' AND read_at IS NULL;

EXPLAIN QUERY PLAN
SELECT 1 FROM notifications
WHERE user_id='__cms_plan_probe__' AND notification_type='SLA_WARNING'
  AND entity_type IS 'SLA_INSTANCE' AND entity_id IS '__cms_plan_probe__';

EXPLAIN QUERY PLAN
SELECT sla_instance_id FROM sla_instances
WHERE status='RUNNING' AND target_at <= datetime('now');

EXPLAIN QUERY PLAN
SELECT sla_instance_id FROM sla_instances i
WHERE i.status='RUNNING' AND i.warning_at IS NOT NULL AND i.warning_at <= datetime('now')
  AND NOT EXISTS (SELECT 1 FROM sla_timer_events e
                  WHERE e.sla_instance_id=i.sla_instance_id AND e.event_type='WARNING');
