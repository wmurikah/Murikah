# Hass CMS schema dictionary (ground truth)

Introspected from the live Turso CMS database on 2026-07-07 (pragma*table_info per
table). One line per table, columns in definition order. This drives
`cms/db/gen-columns.mjs`, which regenerates `src/lib/cms/schema/columns.ts`. A
column referenced in code that is not listed here is a compile error, so schema
drift fails the build rather than a request. No FTS shadow tables exist in this
database. Regenerate the snapshot with `cms/db/introspect.mjs` against the live
database (`TURSO_CMS*\*`) when the schema changes.

- **approval_requests**: request_id, workflow_id, entity_type, entity_id, country_code, amount, currency_code, tier, required_role_codes, submitted_by, submitted_at, assigned_to, status, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, escalation_level, escalated_at, sla_due_at, comments, created_at, updated_at
- **approval_workflows**: workflow_id, name, entity_type, rules_json, country_code, is_active, created_at, updated_at
- **audit_log**: log_id, entity_type, entity_id, action, actor_type, actor_id, actor_email, actor_ip, actor_user_agent, before_json, after_json, metadata, country_code, created_at
- **bot_conversations**: turn_id, session_id, user_id, user_role, config_id, user_message, bot_response, tool_calls_json, tokens_used, latency_ms, status, error_message, created_at
- **bot_llm_configs**: config_id, provider, label, model, endpoint_url, api_key_property, max_tokens, temperature, system_prompt, is_active, is_default, allowed_roles, notes, created_by, created_at, updated_at
- **bot_tools**: tool_id, service, action, description, params_schema_json, is_write, required_permission, is_enabled, created_at
- **branding**: scope_code, app_name, logo_url, primary_color, secondary_color, accent_color, extra_json, updated_by, updated_at
- **business_hours**: hours_id, country_code, name, is_default, monday_start, monday_end, tuesday_start, tuesday_end, wednesday_start, wednesday_end, thursday_start, thursday_end, friday_start, friday_end, saturday_start, saturday_end, sunday_start, sunday_end, timezone, created_at, updated_at
- **churn_risk_factors**: factor_id, customer_id, factor_type, factor_weight, current_value, previous_value, threshold, score, notes, recorded_at, created_at
- **config**: config_key, config_value, value_type, description, country_code, is_encrypted, updated_by, updated_at
- **contacts**: contact_id, customer_id, first_name, last_name, email, phone, phone_alt, job_title, department, contact_type, is_decision_maker, is_portal_user, portal_role, password_hash, auth_provider, auth_uid, password_changed_at, must_change_password, mfa_enabled, mfa_secret, preferred_language, notification_email, notification_sms, notification_whatsapp, notification_push, failed_login_attempts, locked_until, last_login_at, status, created_at, updated_at
- **countries**: country_code, name, affiliate_code, currency_code, currency_symbol, timezone, dialing_code, is_active, created_at, updated_at
- **customers**: customer_id, account_number, oracle_customer_code, company_name, trading_name, customer_type, segment_id, country_code, affiliate_code, currency_code, email, phone, address, city, industry, website, tax_pin, registration_number, credit_limit, credit_used, payment_terms, status, onboarding_status, risk_score, risk_level, lifetime_value, relationship_owner_id, parent_customer_id, source, notes, created_by, created_at, updated_at
- **delivery_locations**: location_id, customer_id, name, address_line1, address_line2, city, region, country_code, postal_code, latitude, longitude, delivery_instructions, contact_name, contact_phone, access_hours, requires_appointment, tank_capacity, is_default, is_verified, verified_by, verified_at, status, created_at, updated_at
- **depots**: depot_id, code, name, country_code, city, address, depot_type, capacity, products_available, contact_phone, contact_email, latitude, longitude, is_active, created_at, updated_at
- **documents**: document_id, customer_id, document_type, name, file_id, file_path, file_size, mime_type, document_number, issue_date, expiry_date, issuing_authority, is_mandatory, status, rejection_reason, reminder_sent_at, uploaded_by_type, uploaded_by_id, verified_by, verified_at, verification_notes, version, previous_version_id, created_at, updated_at
- **drivers**: driver_id, employee_id, first_name, last_name, phone, email, license_number, license_expiry, country_code, depot_id, status, is_active, created_at, updated_at
- **entity_statuses**: entity, status_code, label_key, color, sort_order, is_terminal
- **escalation_paths**: path_id, scope, category, level, role_code, delay_minutes, created_at
- **exchange_rates**: rate_id, from_currency, to_currency, rate, effective_from, source, updated_by, updated_at
- **holidays**: holiday_id, country_code, name, holiday_date, is_recurring, created_at
- **integration_log**: log_id, integration, direction, endpoint, method, request_body, response_body, status_code, error_message, duration_ms, reference_type, reference_id, created_at
- **invoices**: invoice_id, invoice_number, oracle_invoice_id, order_id, customer_id, country_code, currency_code, issue_date, due_date, subtotal, tax_amount, total_amount, status, payment_status, paid_amount, paid_date, payment_method, payment_reference, payment_proof_file_id, etims_invoice_number, etims_qr_url, etims_submitted_at, etims_status, notes, created_by, created_at, updated_at
- **job_queue**: job_id, type, payload, priority, status, attempts, max_attempts, next_run_at, started_at, completed_at, error, created_at
- **knowledge_articles**: article_id, category_id, title, slug, summary, content, language, tags, is_public, is_featured, status, helpful_yes, helpful_no, views, published_at, created_by, created_at, updated_at
- **knowledge_categories**: category_id, name, slug, description, icon, sort_order, parent_category_id, is_public, is_active, created_at, updated_at
- **localization**: string_key, locale, value
- **menu_items**: item_code, parent_code, audience, label_key, icon, route, sort_order, required_permission, role_scope, is_active
- **mfa_challenges**: challenge_id, user_type, user_id, role, mode, pending_secret, fails, expires_at, consumed_at, created_at
- **notification_preferences**: preference_id, recipient_type, recipient_id, notification_type, channel_email, channel_sms, channel_whatsapp, channel_push, channel_in_app, is_enabled, created_at, updated_at
- **notification_templates**: template_id, name, event_type, channel, language, subject, body_html, body_text, variables, country_code, is_active, created_at, updated_at
- **notifications**: notification_id, recipient_type, recipient_id, notification_type, reference_type, reference_id, title, message, priority, email_sent, sms_sent, is_read, in_app_read_at, action_url, expires_at, created_at
- **order_lines**: line_id, order_id, product_id, product_name, quantity, unit_of_measure, unit_price, discount_percent, tax_rate, line_subtotal, line_tax, line_total, delivered_quantity, delivery_variance_reason, created_at
- **order_status_history**: history_id, order_id, from_status, to_status, changed_by_type, changed_by_id, changed_by_name, notes, latitude, longitude, created_at
- **orders**: order_id, order_number, oracle_order_id, po_number, customer_id, contact_id, delivery_location_id, source_depot_id, price_list_id, country_code, currency_code, status, payment_status, requested_date, requested_time_from, requested_time_to, confirmed_date, confirmed_time, subtotal, tax_amount, delivery_fee, discount_amount, total_amount, special_instructions, is_recurring, recurring_schedule_id, vehicle_id, driver_id, submitted_at, approved_at, approved_by, dispatched_at, delivered_at, cancelled_at, cancelled_by, cancelled_reason, delivery_notes, delivery_confirmed_by, invoice_number, invoice_date, created_by_type, created_by_id, created_at, updated_at
- **password_history**: history_id, user_type, user_id, password_hash, created_at
- **password_resets**: reset_id, email, user_type, user_id, otp_hash, expires_at, consumed_at, created_at
- **payment_uploads**: upload_id, customer_id, order_id, invoice_id, file_id, file_path, file_name, payment_method, amount, currency_code, reference_number, upload_date, uploaded_by, status, reviewed_by, review_notes, created_at
- **permissions**: permission_code, label, category, description, created_at
- **po_approvals**: purchase_number, req_description, nature, original_creation_date, submission_for_approval_date, time_diff_raisepo_toaprovalsubmit, purchase_order_created_by, first_approval_date, second_approval_date, third_approval_date, fourth_approval_date, fifth_approval_date, sixth_approval_date, seventh_approval_date, first_approver, second_approver, third_approver, fourth_approver, fifth_approver, sixth_approver, seventh_approver, first_approvals_variance, second_approvals_variance, third_approvals_variance, fourth_approvals_variance, fifth_approvals_variance, sixth_approvals_variance, seventh_approvals_variance, authorization_status, source, source_batch_id, loaded_at, updated_at
- **po_so_comments**: comment_id, doc_type, doc_number, author_id, author_name, recipient, body, email_sent, email_sent_at, created_at
- **price_list**: price_id, name, country_code, currency_code, segment_id, customer_id, is_default, effective_from, effective_to, status, approved_by, approved_at, notes, created_by, created_at, updated_at
- **price_list_items**: item_id, price_list_id, product_id, depot_id, unit_price, min_quantity, max_quantity, discount_percent, tax_rate, effective_from, effective_to, created_at
- **products**: product_id, sku, name, description, category, subcategory, unit_of_measure, min_order_quantity, max_order_quantity, requires_special_handling, handling_instructions, image_url, is_active, created_at, updated_at
- **recurring_schedule**: schedule_id, customer_id, name, delivery_location_id, frequency, frequency_interval, day_of_week, day_of_month, preferred_time_from, preferred_time_to, start_date, end_date, next_order_date, is_active, auto_submit, special_instructions, created_by, created_at, updated_at
- **recurring_schedule_lines**: line_id, schedule_id, product_id, quantity, unit_price, created_at
- **retention_activities**: activity_id, customer_id, activity_type, subject, description, outcome, next_action, next_action_date, performed_by, performed_at, notes, created_at
- **role_permissions**: role_code, permission_code, granted_at
- **roles**: role_code, role_name, description, scope, is_system, mfa_required, is_active, created_at, updated_at
- **segments**: segment_id, name, code, description, sla_multiplier, credit_multiplier, priority_level, color, min_volume, max_volume, credit_terms_days, discount_percentage, is_active, created_at, updated_at
- **sessions**: session_id, user_type, user_id, token_hash, ip_address, user_agent, country_code, is_active, expires_at, idle_timeout_minutes, last_activity_at, created_at, role
- **signup_requests**: request_id, company_name, first_name, last_name, email, phone, job_title, account_type, customer_id, country_code, tax_pin, registration_number, certificate_of_incorporation, dealer_code, station_name, card_number, kra_pin, account_number, company_address, pending_password_hash, kyc_status, status, approved_by, approved_at, rejection_reason, rejected_at, submitted_at, reviewed_by, reviewed_at, decision_reason, provisioned_id, provisioned_type
- **sla_config**: sla_id, name, country_code, segment_id, category, priority, channel, process_type, acknowledge_minutes, response_minutes, resolve_minutes, escalation_1_minutes, escalation_2_minutes, escalation_3_minutes, business_hours_only, effective_from, effective_to, is_active, created_by, created_at, updated_at
- **so_approvals**: affiliate, document_number, posting_date, actual_order_date_user_input, customer_code, customer_name, user_name, create_date, create_time, create_date_time, approval_date1, approval_date, approval_time, approval_date_time, finance_variance, delayed_raising_orders, approval_status, approver, credit_hold_date, credit_hold_name, released_flag, release_reason_code, credit_hold_release_date, hold_released_by, credit_variance, invoice_creation_date, invoice_variance, line_number, ordered_item, loading_authority_date, loading_authority_variance, source, source_batch_id, loaded_at, updated_at
- **staff_messages**: message_id, room_id, room_type, sender_id, sender_name, content, is_internal, read_by, parent_message_id, edited_at, created_at, updated_at
- **status_transitions**: entity, from_status, to_status, required_permission, action_label_key
- **teams**: team_id, team_name, code, description, department, country_code, team_lead_id, parent_team_id, escalation_team_id, auto_assign, assignment_method, working_hours, timezone, is_active, created_at, updated_at
- **ticket_attachments**: attachment_id, ticket_id, comment_id, file_name, file_path, file_size, mime_type, uploaded_by_type, uploaded_by_id, is_inline, created_at
- **ticket_comments**: comment_id, ticket_id, parent_comment_id, author_type, author_id, author_name, content, content_html, is_internal, is_resolution, channel, external_message_id, sentiment, created_at, updated_at
- **ticket_history**: history_id, ticket_id, field_name, old_value, new_value, changed_by_type, changed_by_id, changed_by_name, change_reason, created_at
- **tickets**: ticket_id, ticket_number, customer_id, contact_id, channel, category, subcategory, subject, description, priority, status, assigned_to, assigned_team_id, related_order_id, country_code, sla_config_id, sla_acknowledge_by, sla_response_by, sla_resolve_by, sla_acknowledge_breached, sla_response_breached, sla_resolve_breached, acknowledged_at, first_response_at, resolved_at, closed_at, resolution_type, resolution_summary, root_cause, root_cause_category, satisfaction_rating, satisfaction_comment, escalation_level, escalated_to, escalated_at, escalation_reason, reopened_count, last_reopened_at, merged_into_id, tags, created_by, created_at, updated_at
- **user_roles**: user_id, role_code, assigned_by, assigned_at
- **users**: user_id, employee_id, email, first_name, last_name, phone, avatar_url, department, country_code, countries_access, team_id, reports_to, max_tickets, password_hash, password_changed_at, must_change_password, mfa_enabled, mfa_secret, status, failed_login_attempts, locked_until, last_login_at, last_activity_at, created_at, updated_at
- **vehicles**: vehicle_id, registration_number, vehicle_type, capacity, capacity_unit, country_code, depot_id, status, last_service_date, next_service_date, gps_device_id, is_active, created_at, updated_at
