-- Read-only plan probes. Run before and after cleanup, separately from the
-- migration transaction. No matching application records are retrieved.

-- idx_users_email
EXPLAIN QUERY PLAN SELECT email FROM users
WHERE email='__cms_plan_probe__';

-- idx_accounts_oracle_code
EXPLAIN QUERY PLAN SELECT oracle_customer_code FROM accounts
WHERE oracle_customer_code='__cms_plan_probe__';

-- idx_snapshots_entity
EXPLAIN QUERY PLAN SELECT entity_type, entity_id, version_no FROM record_snapshots
WHERE entity_type='__cms_plan_probe__' AND entity_id='__cms_plan_probe__' AND version_no='__cms_plan_probe__';
EXPLAIN QUERY PLAN SELECT entity_type, entity_id, version_no FROM record_snapshots
WHERE entity_type='__cms_plan_probe__' ORDER BY entity_id, version_no;

-- idx_business_units_code
EXPLAIN QUERY PLAN SELECT business_unit_code FROM business_units
WHERE business_unit_code='__cms_plan_probe__';

-- ix_sla_escalation_instance
EXPLAIN QUERY PLAN SELECT sla_instance_id, escalation_level FROM sla_escalation_events
WHERE sla_instance_id='__cms_plan_probe__' AND escalation_level='__cms_plan_probe__';
EXPLAIN QUERY PLAN SELECT sla_instance_id, escalation_level FROM sla_escalation_events
WHERE sla_instance_id='__cms_plan_probe__' ORDER BY escalation_level;

-- ix_so_extract_batch
EXPLAIN QUERY PLAN SELECT import_batch_id, source_row_number FROM so_extract_rows
WHERE import_batch_id='__cms_plan_probe__' AND source_row_number='__cms_plan_probe__';
EXPLAIN QUERY PLAN SELECT import_batch_id, source_row_number FROM so_extract_rows
WHERE import_batch_id='__cms_plan_probe__' ORDER BY source_row_number;

-- ix_po_extract_batch
EXPLAIN QUERY PLAN SELECT import_batch_id, source_row_number FROM po_extract_rows
WHERE import_batch_id='__cms_plan_probe__' AND source_row_number='__cms_plan_probe__';
EXPLAIN QUERY PLAN SELECT import_batch_id, source_row_number FROM po_extract_rows
WHERE import_batch_id='__cms_plan_probe__' ORDER BY source_row_number;

-- ix_bot_msg_conv
EXPLAIN QUERY PLAN SELECT bot_conversation_id, sequence_no FROM bot_messages
WHERE bot_conversation_id='__cms_plan_probe__' AND sequence_no='__cms_plan_probe__';
EXPLAIN QUERY PLAN SELECT bot_conversation_id, sequence_no FROM bot_messages
WHERE bot_conversation_id='__cms_plan_probe__' ORDER BY sequence_no;
