# hassaudit column dictionary (ground truth)

This is the authoritative column list, taken directly from the live Turso
`hassaudit` database (Build Prompt 18). The database is the recovered source of
truth: the code is bound to it, not the other way round. Do NOT rename a database
column to match the code; change the code.

`src/lib/grc/schema/columns.ts` is generated from this file by
`grc/db/gen-columns.mjs` (`node grc/db/gen-columns.mjs`). Every GRC query takes
its column names from that typed layer (imported as `@grc/schema/columns`), so a
misspelt or non-existent column fails `pnpm build` rather than the user's screen.
Keep this file and the generated module in step: edit here, regenerate, commit
both.

The full-text-search tables (`work_papers_fts`, `action_plans_fts` and their
`_data`/`_idx`/`_docsize`/`_config` shadow tables) are deliberately absent:
SQLite manages them, and they are only ever touched through FTS `MATCH` helpers,
never their internal columns.

## Tables

- **action_plan_history**: history_id, action_plan_id, action, from_status, to_status, comments, user_id, user_name, action_date
- **action_plan_owners**: action_plan_id, user_id, is_original, is_current, added_at, added_by, removed_at, removed_by
- **action_plans**: action_plan_id, organization_id, work_paper_id, affiliate_code, action_ref, action_description, implementation_notes, priority, status, target_date, due_date, revised_date, completed_date, created_by, created_at, updated_at, deleted_at, action_number, owner_ids, owner_names, created_by_role, auditee_proposed, days_overdue, delegated_by_id, delegated_date, delegation_notes, original_owner_ids, implemented_date, auditor_review_comments, auditor_review_by, auditor_review_date, auditor_review_status, hoa_review_comments, hoa_review_by, hoa_review_date, hoa_review_status, final_status, response_id, delegation_accepted, delegation_accepted_date, delegation_rejected, delegation_reject_reason, delegation_rejected_by, delegation_rejected_date, delegated_by_name
- **affiliates**: affiliate_code, organization_id, affiliate_name, country, region, is_active, created_at, updated_at, deleted_at
- **ai_invocations**: invocation_id, organization_id, user_id, provider_code, model, purpose, related_entity_type, related_entity_id, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, success, error_message, request_payload, response_payload, occurred_at, invoker_role, auto_action_taken, auto_action_entity_id
- **ai_providers**: provider_code, display_name, api_key_secret_ref, default_model, is_enabled, cost_per_1k_input, cost_per_1k_output, updated_at
- **api_keys**: api_key_id, organization_id, user_id, name, key_hash, key_prefix, scopes, expires_at, last_used_at, last_used_ip, is_active, revoked_at, revoked_by, created_at, created_by
- **audit_activity**: event_id, organization_id, occurred_at, actor_user_id, actor_email, actor_role, actor_ip, actor_location, user_agent, action, module_code, entity_type, entity_id, details_json, success
- **audit_areas**: audit_area_id, organization_id, area_code, area_name, description, is_active, created_at, updated_at, deleted_at
- **audit_log**: log_id, action, entity_type, entity_id, old_data, new_data, actor_user_id, actor_email, actor_ip, occurred_at
- **audit_log_anchors**: anchor_id, last_log_id, log_count, cumulative_hash, anchored_at, external_proof
- **auditee_responses**: response_id, organization_id, work_paper_id, action_plan_id, response_round, response_text, status, submitted_by, submitted_date, reviewed_by, review_date, review_comments, created_at, updated_at, deleted_at, round_number, response_type, management_response, submitted_by_id, submitted_by_name, action_plan_ids, reviewed_by_id, reviewed_by_name
- **backup_runs**: backup_id, backup_type, organization_id, started_at, completed_at, status, storage_location, size_bytes, checksum_sha256, encryption_key_ref, row_counts, error_message, triggered_by, retention_until
- **config**: organization_id, config_key, config_value, updated_at
- **dashboard_snapshots**: snapshot_id, organization_id, snapshot_type, snapshot_date, metrics, generated_at
- **deletion_queue**: queue_id, entity_type, entity_id, soft_deleted_at, hard_delete_after, reason, requested_by, processed_at
- **departments**: department_id, organization_id, affiliate_code, department_code, department_name, parent_department, is_active, created_at, updated_at, deleted_at
- **email_templates**: template_code, organization_id, name, subject, body, is_active, updated_at, template_name, subject_template, body_template, body_template_text, locale, version
- **enum_values**: enum_type, enum_value, display_label, display_order, color_hex, is_terminal, is_active, metadata
- **export_jobs**: export_id, organization_id, requested_by, export_type, format, filters, status, file_id, row_count, requested_at, completed_at, expires_at, error_message
- **feature_flags**: organization_id, flag_key, description, is_enabled, rollout_percentage, targeting_rules, updated_at, updated_by
- **file_attachments**: attachment_id, file_id, entity_type, entity_id, file_category, attached_by, attached_at
- **files**: file_id, organization_id, drive_file_id, file_name, mime_type, size_bytes, uploaded_by, created_at, deleted_at, storage_backend, storage_key, content_hash, content_hash_algo
- **in_app_notifications**: in_app_id, user_id, title, body, severity, related_entity_type, related_entity_id, deep_link, read_at, created_at, expires_at
- **ip_access_rules**: rule_id, organization_id, cidr, rule_type, description, is_active, expires_at, created_at, created_by
- **job_locks**: lock_key, holder, acquired_at, expires_at, metadata
- **legal_holds**: hold_id, name, description, entity_filter, placed_at, placed_by, released_at, released_by
- **login_attempts**: attempt_id, email, user_id, organization_id, success, failure_reason, ip_address, user_agent, attempted_at
- **notification_dead_letter**: notification_id, original_queue_data, last_error, failed_at, requeued_at, requeued_by
- **notification_queue**: notification_id, organization_id, template_code, recipient_user_id, recipient_email, type, related_entity_type, related_entity_id, subject, body, status, attempts, error, sent_at, created_at, batch_type, priority, channel, recipient_name, is_cc, cc_of_user_id, payload, rendered_subject, rendered_body, max_attempts, scheduled_for, record_id, error_message, deleted_at, module
- **organizations**: organization_id, org_code, org_name, legal_name, country, timezone, locale, fiscal_year_start, data_residency, is_active, created_at, updated_at, deleted_at, billing_email
- **password_history**: history_id, user_id, password_hash, password_salt, password_algo, changed_at, changed_by
- **password_reset_tokens**: token_id, user_id, token_hash, expires_at, used_at, requested_ip, created_at
- **permission_actions**: action_code, action_name
- **permission_modules**: module_code, module_name, description
- **plans**: plan_code, name, features_json, price_minor, currency, is_active, created_at
- **rate_limit_buckets**: bucket_key, bucket_type, counter, window_start, window_size_seconds, blocked_until
- **reminders**: reminder_id, reminder_type, related_entity_type, related_entity_id, target_user_id, scheduled_for, sent_at, cancelled_at, cancel_reason, escalation_level
- **restore_runs**: restore_id, backup_id, target, started_at, completed_at, status, requested_by, approved_by, rows_restored, verification_status, error_message, notes
- **retention_policies**: policy_id, entity_type, retention_days, archive_target, last_run_at, rows_pruned, is_active, legal_hold, description
- **role_permissions**: organization_id, role_code, module_code, action_code, is_allowed, scope_to_affiliate
- **roles**: role_code, role_name, description, is_system, created_at
- **saved_reports**: report_id, organization_id, owner_user_id, name, description, report_type, query_definition, schedule_cron, last_generated_at, is_shared, created_at, updated_at
- **scheduled_jobs**: job_id, job_name, cron_expression, is_enabled, last_run_at, last_run_status, last_run_duration_ms, last_error, next_run_at, created_at, updated_at
- **schema_migrations**: version, applied_at, applied_by, checksum, execution_ms, success, error_message
- **security_events**: event_id, occurred_at, event_type, severity, user_id, actor_email, ip_address, details, resolved_at, resolved_by
- **sessions**: session_id, user_id, token_hash, ip, user_agent, created_at, expires_at, last_seen_at
- **status_transitions**: enum_type, from_status, to_status, required_role, requires_comment
- **sub_areas**: sub_area_id, audit_area_id, organization_id, sub_area_name, control_objectives, risk_description, test_objective, testing_steps, is_active, created_at, updated_at, deleted_at
- **subscriptions**: subscription_id, organization_id, plan_code, status, billing_cycle, seats, trial_ends_at, current_period_start, current_period_end, external_ref, created_at, updated_at
- **users**: user_id, organization_id, email, full_name, password_hash, role_code, affiliate_code, phone, status, must_change_password, last_login_at, created_at, updated_at, deleted_at, is_platform_owner
- **webhook_endpoints**: endpoint_id, organization_id, name, target_url, secret, event_filter, is_active, last_success_at, last_failure_at, consecutive_failures, created_at, created_by
- **work_paper_cc_recipients**: work_paper_id, email, user_id, added_at
- **work_paper_requirements**: requirement_id, work_paper_id, organization_id, description, requirement_type, status, notes, due_date, created_at, updated_at, deleted_at
- **work_paper_responsibles**: work_paper_id, user_id, role_in_finding, added_at, added_by
- **work_paper_revisions**: revision_id, work_paper_id, revision_number, action, from_status, to_status, comments, changes_summary, user_id, user_name, action_date
- **work_papers**: work_paper_id, organization_id, work_paper_ref, created_by, year, affiliate_code, audit_area_id, sub_area_id, work_paper_date, audit_period_from, audit_period_to, control_objectives, control_classification, control_type, control_frequency, control_standards, risk_description, test_objective, testing_steps, observation_title, observation_description, risk_rating, risk_summary, recommendation, management_response, assigned_auditor_id, assigned_auditor_name, status, final_status, revision_count, prepared_by_id, prepared_by_name, prepared_date, submitted_date, reviewed_by_id, reviewed_by_name, review_date, review_comments, approved_by_id, approved_by_name, approved_date, sent_to_auditee_date, response_status, response_deadline, response_round, response_submitted_by, response_submitted_date, response_reviewed_by, response_review_date, response_review_comments, evidence_override, created_at, updated_at, deleted_at
- **workflow_terminal_states**: workflow_name, terminal_status, description, created_at
