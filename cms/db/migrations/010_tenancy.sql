-- ============================================================================
-- 010_tenancy.sql  -  Hass CMS multi-tenant SaaS layer
-- ============================================================================
-- The ported live schema is single-tenant and country-scoped. This migration
-- adds the tenant layer above it, with Hass as the first tenant, mirroring how
-- Engineering Rhythm and the GRC platform scope by organisation. Apply to the
-- live database, then run `pnpm cms:db:introspect` and `pnpm cms:db:columns` so
-- the typed column layer picks up these tables (and, as they are added per
-- module, the tenant_id columns on the domain tables).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- Tenants (Hass is the first).
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,          -- for a future per-tenant subdomain
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plans a tenant can subscribe to; features_json gates premium features.
CREATE TABLE IF NOT EXISTS plans (
  plan_code     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  price_minor   INTEGER NOT NULL DEFAULT 0,   -- price in the minor unit (cents)
  currency_code TEXT NOT NULL DEFAULT 'KES',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A tenant's subscription (one active per tenant), with trial support.
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  plan_code       TEXT NOT NULL REFERENCES plans(plan_code),
  status          TEXT NOT NULL DEFAULT 'TRIALING', -- TRIALING | ACTIVE | PAST_DUE | CANCELLED
  trial_ends_at   TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  current_period_end TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_tenant_sub_tenant ON tenant_subscriptions(tenant_id, status);

-- Seed the first tenant and a starter plan set.
INSERT OR IGNORE INTO tenants (tenant_id, name, slug) VALUES ('hass', 'Hass', 'hass');
INSERT OR IGNORE INTO plans (plan_code, name, features_json, price_minor) VALUES
  ('starter',      'Starter',      '{"customers":true,"orders":true,"tickets":true}', 0),
  ('professional', 'Professional', '{"customers":true,"orders":true,"tickets":true,"reports":true,"ai_bot":true}', 0),
  ('enterprise',   'Enterprise',   '{"customers":true,"orders":true,"tickets":true,"reports":true,"ai_bot":true,"integrations":true}', 0);
INSERT OR IGNORE INTO tenant_subscriptions (subscription_id, tenant_id, plan_code, status)
  VALUES ('hass-sub', 'hass', 'enterprise', 'ACTIVE');

-- Per module, its domain tables gain the tenant scope, e.g.:
--   ALTER TABLE customers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'hass' REFERENCES tenants(tenant_id);
--   CREATE INDEX ix_customers_tenant ON customers(tenant_id);
-- Existing rows default to the Hass tenant; every query then scopes by tenant_id.
