-- ============================================================================
-- 02_drop_all.sql  -  empty the CMS database, keeping the database itself
-- ============================================================================
-- Run this THIRD, after 00_inventory.sql has confirmed the target and
-- 01_dump_schema_note.md has preserved the structure in readable form.
--
-- WHAT THIS DOES
--   Drops every object the CMS created, leaving an empty database.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   It does not drop, rename or recreate the database. There is no
--   database-level destructive statement anywhere in this file, and there must
--   never be one. The database, the URL in TURSO_CMS_DATABASE_URL and the token in
--   TURSO_CMS_AUTH_TOKEN are preserved on purpose: the redesign reconnects
--   with the same names and the same values, and recreating the database would
--   mean re-issuing credentials and re-setting the worker secrets for nothing.
--   It touches no object outside this database.
--
-- SAFE TO RE-RUN
--   Every statement uses IF EXISTS, so running the file twice is harmless and
--   the second run simply reports nothing left to do.
--
-- FOREIGN KEYS
--   libSQL and SQLite leave foreign key enforcement OFF per connection unless
--   it is switched on, so in most consoles these drops succeed in any order.
--   The PRAGMA below makes that explicit rather than assumed, and the drops are
--   additionally ordered children before parents, so the file is correct even
--   in a console that enforces keys and ignores the PRAGMA. Views and triggers
--   would be dropped ahead of the tables; this schema has none, which the
--   inventory in step 1 confirms.
--
--   If your console rejects PRAGMA statements, delete the two PRAGMA lines and
--   run the rest as it stands. The ordering carries the file on its own.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- Views: none in this schema. Kept as a comment so the shape of the teardown
-- is complete and a future view is not forgotten here.
--   DROP VIEW IF EXISTS <name>;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Triggers: none in this schema, for the same reason.
--   DROP TRIGGER IF EXISTS <name>;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Indexes: all 64 are attached to the tables below and are dropped with them,
-- so none is named separately. SQLite drops a table's indexes with the table.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables, children before parents. 64 tables from the 2026-07-07 snapshot,
-- plus the three from the tenancy migration which may or may not have been
-- applied; IF EXISTS covers both cases.
-- ---------------------------------------------------------------------------

-- The multi-tenant layer added by cms/db/migrations/010_tenancy.sql. Dropped
-- first: tenant_subscriptions is a child of both tenants and plans.
DROP TABLE IF EXISTS tenant_subscriptions;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS tenants;

-- The 64 tables, ordered so that every child is dropped before its parent.
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS bot_conversations;
DROP TABLE IF EXISTS bot_tools;
DROP TABLE IF EXISTS branding;
DROP TABLE IF EXISTS business_hours;
DROP TABLE IF EXISTS churn_risk_factors;
DROP TABLE IF EXISTS config;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS entity_statuses;
DROP TABLE IF EXISTS escalation_paths;
DROP TABLE IF EXISTS exchange_rates;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS integration_log;
DROP TABLE IF EXISTS job_queue;
DROP TABLE IF EXISTS knowledge_articles;
DROP TABLE IF EXISTS localization;
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notification_templates;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS order_lines;
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS password_history;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS payment_uploads;
DROP TABLE IF EXISTS po_approvals;
DROP TABLE IF EXISTS po_so_comments;
DROP TABLE IF EXISTS price_list_items;
DROP TABLE IF EXISTS recurring_schedule_lines;
DROP TABLE IF EXISTS retention_activities;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS signup_requests;
DROP TABLE IF EXISTS so_approvals;
DROP TABLE IF EXISTS staff_messages;
DROP TABLE IF EXISTS status_transitions;
DROP TABLE IF EXISTS ticket_attachments;
DROP TABLE IF EXISTS ticket_history;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS approval_workflows;
DROP TABLE IF EXISTS bot_llm_configs;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS knowledge_categories;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS price_list;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS recurring_schedule;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS ticket_comments;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS sla_config;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS delivery_locations;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS vehicles;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS depots;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS countries;

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Proof. This is the same query as 00_inventory.sql step 1. It must now return
-- NO ROWS. Any row it returns is an object this script did not name: copy it
-- into a DROP statement of the right kind and re-run.
-- ---------------------------------------------------------------------------
SELECT type, name, tbl_name
FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '\_litestream%' ESCAPE '\'
ORDER BY
  CASE type WHEN 'trigger' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END,
  name;
