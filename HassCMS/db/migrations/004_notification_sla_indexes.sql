-- Targeted notification/SLA read indexes for the observed hass-cms schema.
-- Manual Turso SQL console migration; no other migration is a prerequisite.
-- Adds no columns, changes no application rows, and creates no UNIQUE rules.
-- Inspect existing index definitions with the companion diagnostic first.
-- IF NOT EXISTS preserves an existing index of the same name; it does not
-- reconcile a name that already has a different definition.

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(user_id, notification_type, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sla_instances_due
  ON sla_instances(status, target_at);
CREATE INDEX IF NOT EXISTS idx_sla_instances_warning
  ON sla_instances(status, warning_at);
CREATE INDEX IF NOT EXISTS idx_sla_timer_instance_event
  ON sla_timer_events(sla_instance_id, event_type);

-- Read-only verification. All five rows must show OK; otherwise inspect the
-- existing definition rather than blindly dropping or replacing an index.
WITH expected(index_name, table_name, key_columns) AS (
  VALUES
    ('idx_notifications_user_unread','notifications','user_id,read_at'),
    ('idx_notifications_dedup','notifications','user_id,notification_type,entity_type,entity_id'),
    ('idx_sla_instances_due','sla_instances','status,target_at'),
    ('idx_sla_instances_warning','sla_instances','status,warning_at'),
    ('idx_sla_timer_instance_event','sla_timer_events','sla_instance_id,event_type')
)
SELECT e.index_name,
       CASE WHEN s.type='index' AND s.tbl_name=e.table_name
         AND (SELECT group_concat(name, ',') FROM (
           SELECT name FROM pragma_index_info(e.index_name) ORDER BY seqno
         ))=e.key_columns
         AND EXISTS (SELECT 1 FROM pragma_index_list(e.table_name) p
                     WHERE p.name=e.index_name AND p."unique"=0 AND p.partial=0)
         AND NOT EXISTS (SELECT 1 FROM pragma_index_xinfo(e.index_name) x
                         WHERE x."key"=1 AND (x.coll<>'BINARY' OR x."desc"<>0 OR x.cid<0))
       THEN 'OK' ELSE 'MISSING_OR_MISMATCHED' END AS verification
FROM expected e LEFT JOIN sqlite_schema s ON s.name=e.index_name
ORDER BY e.index_name;
