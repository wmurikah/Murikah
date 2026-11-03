-- Optional recovery only: restores the eight exported explicit indexes.
-- Review current definitions first; IF NOT EXISTS does not repair name conflicts.
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_accounts_oracle_code ON accounts(oracle_customer_code);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON record_snapshots(entity_type, entity_id, version_no);
CREATE INDEX IF NOT EXISTS idx_business_units_code ON business_units(business_unit_code);
CREATE INDEX IF NOT EXISTS ix_sla_escalation_instance
    ON sla_escalation_events(sla_instance_id, escalation_level);
CREATE INDEX IF NOT EXISTS ix_so_extract_batch    ON so_extract_rows(import_batch_id, source_row_number);
CREATE INDEX IF NOT EXISTS ix_po_extract_batch    ON po_extract_rows(import_batch_id, source_row_number);
CREATE INDEX IF NOT EXISTS ix_bot_msg_conv        ON bot_messages(bot_conversation_id, sequence_no);
