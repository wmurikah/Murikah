-- ============================================================================
-- ENGINEERING RHYTHM  (Murikah Labs)
-- Multi-tenant engineering and facilities maintenance workflow platform
-- Target: Turso / libSQL (SQLite dialect)
--
-- Runs in the Turso web SQL editor (paste whole file) or via:
--   turso db shell engineering-rhythm < schema.sql
--
-- Conventions:
--   - Primary keys: TEXT, default lower(hex(randomblob(16))). The app may pass
--     its own ULID instead; the default only fires when no id is supplied.
--   - Timestamps: TEXT, ISO-8601 UTC, e.g. 2026-07-02T09:15:03.221Z.
--   - Money: INTEGER minor units (KES cents). currency is ISO-4217, default KES.
--   - Tenancy: every business table carries org_id referencing organisations(id).
--   - Enumerations are enforced with CHECK constraints, not lookup tables.
--   - Soft delete: deleted_at (NULL = live) on core records.
--
-- Foreign keys are OFF by default on each libSQL connection. Enable per
-- connection in the app with: PRAGMA foreign_keys = ON;  The line below only
-- affects the session that applies this script.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- SECTION 1  GLOBAL CATALOGUE (not tenant scoped)
-- ============================================================================

-- Subscription tiers for the product itself.
CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  code                TEXT NOT NULL UNIQUE,              -- TRIAL, STARTER, GROWTH, ENTERPRISE
  name                TEXT NOT NULL,
  description         TEXT,
  price_monthly_minor INTEGER NOT NULL DEFAULT 0,
  price_annual_minor  INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'KES',
  max_stations        INTEGER,                            -- NULL = unlimited
  max_users           INTEGER,
  max_contractors     INTEGER,
  features_json       TEXT NOT NULL DEFAULT '{}',         -- {"rfq":true,"pm_automation":true,...}
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Permission registry, shared across all tenants.
CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  key         TEXT NOT NULL UNIQUE,                       -- e.g. workorder.assign
  module      TEXT NOT NULL,                              -- e.g. workorder
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 2  TENANTS AND SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS organisations (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,               -- tenant subdomain / path key
  legal_name          TEXT,
  country             TEXT NOT NULL DEFAULT 'KE',
  base_currency       TEXT NOT NULL DEFAULT 'KES',
  timezone            TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  billing_email       TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id               TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  plan_id              TEXT NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL DEFAULT 'TRIALING'
                         CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  billing_cycle        TEXT NOT NULL DEFAULT 'MONTHLY'
                         CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
  seats                INTEGER,
  current_period_start TEXT,
  current_period_end   TEXT,
  trial_ends_at        TEXT,
  external_ref         TEXT,                              -- payment provider reference
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  invoice_no      TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  period_start    TEXT,
  period_end      TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','PAID','VOID','UNCOLLECTIBLE')),
  issued_at       TEXT,
  paid_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, invoice_no)
);

-- ============================================================================
-- SECTION 3  RBAC
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT REFERENCES organisations(id) ON DELETE CASCADE,  -- NULL = system role
  code        TEXT NOT NULL,                              -- ENGINEER, STATION_MANAGER, ...
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id              TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  full_name           TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT,
  password_hash       TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','DEACTIVATED')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  last_login_at       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT,
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, role_id)
);

-- ============================================================================
-- SECTION 4  ORGANISATION MASTER DATA
-- ============================================================================

CREATE TABLE IF NOT EXISTS regions (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id     TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS stations (
  id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  region_id          TEXT REFERENCES regions(id) ON DELETE SET NULL,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  address            TEXT,
  latitude           REAL,
  longitude          REAL,
  station_manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_base            INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0,1)),  -- mileage base
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at         TEXT,
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id     TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  station_id   TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  tag          TEXT NOT NULL,                             -- asset tag / barcode
  name         TEXT NOT NULL,
  manufacturer TEXT,
  model        TEXT,
  serial_no    TEXT,
  install_date TEXT,
  status       TEXT NOT NULL DEFAULT 'IN_SERVICE'
                 CHECK (status IN ('IN_SERVICE','FAULTY','DECOMMISSIONED')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT,
  UNIQUE (org_id, tag)
);

-- Which engineer owns which station or category of work, for request routing.
CREATE TABLE IF NOT EXISTS engineer_assignments (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id           TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  engineer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('STATION','CATEGORY')),
  station_id       TEXT REFERENCES stations(id) ON DELETE CASCADE,
  category_id      TEXT REFERENCES asset_categories(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 5  CONTRACTORS, TECHNICIANS, SLAS, RATE CARDS
-- ============================================================================

CREATE TABLE IF NOT EXISTS contractors (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  email           TEXT,
  phone           TEXT,
  base_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,  -- mileage origin
  is_prequalified INTEGER NOT NULL DEFAULT 0 CHECK (is_prequalified IN (0,1)),
  portal_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,     -- login account
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUSPENDED','BLACKLISTED')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS contractor_categories (
  org_id        TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  category_id   TEXT NOT NULL REFERENCES asset_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (contractor_id, category_id)
);

CREATE TABLE IF NOT EXISTS contractor_stations (
  org_id        TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  station_id    TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  PRIMARY KEY (contractor_id, station_id)
);

CREATE TABLE IF NOT EXISTS technicians (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id  TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  full_name      TEXT NOT NULL,
  phone          TEXT,
  email          TEXT,
  portal_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     TEXT
);

CREATE TABLE IF NOT EXISTS slas (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  response_hours  INTEGER,
  resolution_hours INTEGER,
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, name)
);

-- Agreed rate cards / price lists. contractor_id NULL means an org-wide list.
CREATE TABLE IF NOT EXISTS rate_cards (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id  TEXT REFERENCES contractors(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'KES',
  effective_from TEXT,
  effective_to   TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rate_items (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rate_card_id    TEXT NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
  category_id     TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  unit            TEXT,                                    -- each, hour, litre, km
  unit_rate_minor INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 6  SERVICE REQUESTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_requests (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id              TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  request_no          TEXT NOT NULL,
  station_id          TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  asset_id            TEXT REFERENCES assets(id) ON DELETE SET NULL,
  category_id         TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  raised_by           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issue               TEXT NOT NULL,
  nature_of_breakdown TEXT,
  is_repeat_call      INTEGER NOT NULL DEFAULT 0 CHECK (is_repeat_call IN (0,1)),
  priority            TEXT NOT NULL DEFAULT 'MEDIUM'
                        CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  assigned_engineer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','ACCEPTED','REJECTED','RFQ',
                                          'ASSIGNED','IN_PROGRESS','CLOSED','CANCELLED')),
  rejection_reason    TEXT,
  accepted_at         TEXT,
  closed_at           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT,
  UNIQUE (org_id, request_no)
);

-- ============================================================================
-- SECTION 7  RFQ AND QUOTES  (workflow 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rfqs (
  id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                 TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rfq_no                 TEXT NOT NULL,
  request_id             TEXT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  created_by             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_date               TEXT,
  approval_threshold_minor INTEGER,                        -- above this, route to procurement
  currency               TEXT NOT NULL DEFAULT 'KES',
  status                 TEXT NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN','CLOSED','AWARDED',
                                             'SENT_TO_PROCUREMENT','CANCELLED')),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, rfq_no)
);

CREATE TABLE IF NOT EXISTS rfq_invitations (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id        TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rfq_id        TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'INVITED'
                  CHECK (status IN ('INVITED','VIEWED','QUOTED','DECLINED')),
  invited_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (rfq_id, contractor_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id            TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rfq_id            TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  contractor_id     TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  quote_no          TEXT,
  diagnosis         TEXT,
  proposed_solution TEXT,
  total_minor       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'KES',
  site_visit_done   INTEGER NOT NULL DEFAULT 0 CHECK (site_visit_done IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'SUBMITTED'
                      CHECK (status IN ('DRAFT','SUBMITTED','SELECTED','REJECTED')),
  submitted_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (rfq_id, contractor_id)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  quote_id        TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  category_id     TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  unit            TEXT,
  qty             REAL NOT NULL DEFAULT 1,
  unit_rate_minor INTEGER NOT NULL DEFAULT 0,
  amount_minor    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  is_spare        INTEGER NOT NULL DEFAULT 0 CHECK (is_spare IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 8  PREVENTIVE MAINTENANCE  (workflow 4)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pm_checklist_templates (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS pm_checklist_items (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  template_id     TEXT NOT NULL REFERENCES pm_checklist_templates(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  item_text       TEXT NOT NULL,
  expected_result TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS pm_schedules (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  asset_id              TEXT REFERENCES assets(id) ON DELETE CASCADE,
  station_id            TEXT REFERENCES stations(id) ON DELETE CASCADE,
  category_id           TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  frequency             TEXT NOT NULL DEFAULT 'MONTHLY'
                          CHECK (frequency IN ('WEEKLY','MONTHLY','QUARTERLY',
                                               'BIANNUAL','ANNUAL','CUSTOM_DAYS')),
  interval_days         INTEGER,                           -- used when CUSTOM_DAYS
  is_automated          INTEGER NOT NULL DEFAULT 1 CHECK (is_automated IN (0,1)),
  assigned_contractor_id TEXT REFERENCES contractors(id) ON DELETE SET NULL, -- auto-allocate
  checklist_template_id TEXT REFERENCES pm_checklist_templates(id) ON DELETE SET NULL,
  sla_id                TEXT REFERENCES slas(id) ON DELETE SET NULL,
  next_due_date         TEXT,
  last_run_date         TEXT,
  status                TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS pm_occurrences (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  pm_schedule_id TEXT NOT NULL REFERENCES pm_schedules(id) ON DELETE CASCADE,
  due_date       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'SCHEDULED'
                   CHECK (status IN ('SCHEDULED','NOTIFIED_1M','NOTIFIED_2W',
                                     'ALLOCATED','WORK_ORDER_CREATED','COMPLETED','MISSED')),
  notified_1m_at TEXT,
  notified_2w_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 9  LPO GROUPING  (workflow 3)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lpos (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  lpo_no          TEXT NOT NULL,
  contractor_id   TEXT NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  base_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,  -- mileage origin
  total_minor     INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED','CANCELLED')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, lpo_no)
);

-- ============================================================================
-- SECTION 10  WORK ORDERS  (all four assignment workflows converge here)
-- ============================================================================

CREATE TABLE IF NOT EXISTS work_orders (
  id                         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                     TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  wo_no                      TEXT NOT NULL,
  request_id                 TEXT REFERENCES service_requests(id) ON DELETE SET NULL,
  lpo_id                     TEXT REFERENCES lpos(id) ON DELETE SET NULL,
  pm_occurrence_id           TEXT REFERENCES pm_occurrences(id) ON DELETE SET NULL,
  quote_id                   TEXT REFERENCES quotes(id) ON DELETE SET NULL,
  station_id                 TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  asset_id                   TEXT REFERENCES assets(id) ON DELETE SET NULL,
  category_id                TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  contractor_id              TEXT REFERENCES contractors(id) ON DELETE SET NULL,
  technician_id              TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  sla_id                     TEXT REFERENCES slas(id) ON DELETE SET NULL,
  source                     TEXT NOT NULL DEFAULT 'REQUEST'
                               CHECK (source IN ('REQUEST','RFQ','PM','LPO')),
  assignment_basis           TEXT NOT NULL DEFAULT 'PREDEFINED_RATE'
                               CHECK (assignment_basis IN ('PREDEFINED_RATE','QUOTE','PM')),
  base_station_id            TEXT REFERENCES stations(id) ON DELETE SET NULL,
  mileage_reference_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'CREATED'
                               CHECK (status IN ('CREATED','CONTRACTOR_NOTIFIED',
                                 'CONTRACTOR_ACCEPTED','CONTRACTOR_REJECTED',
                                 'TECH_ASSIGNED','TECH_ACCEPTED','TECH_REJECTED',
                                 'TECH_ONSITE','IN_PROGRESS','WORK_DONE_PENDING_CONFIRM',
                                 'CLOSED','CANCELLED')),
  created_by                 TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  contractor_accepted_at     TEXT,
  tech_assigned_at           TEXT,
  tech_accepted_at           TEXT,
  onsite_at                  TEXT,
  closed_at                  TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at                 TEXT,
  UNIQUE (org_id, wo_no)
);

-- ============================================================================
-- SECTION 11  ON-SITE EXECUTION: JSA, ARRIVAL, JOB CARD, SPARES, PM RESULTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_safety_analyses (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id              TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  work_order_id       TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  technician_id       TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  content_json        TEXT NOT NULL DEFAULT '{}',
  arrival_requested_at TEXT,
  submitted_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS site_arrivals (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id              TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  work_order_id       TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  technician_id       TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  arrived_at          TEXT,
  confirmed_by        TEXT REFERENCES users(id) ON DELETE SET NULL,   -- station manager
  confirmed_at        TEXT,
  confirmation_status TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (confirmation_status IN ('PENDING','CONFIRMED','DISPUTED')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS job_cards (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id               TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  work_order_id        TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  technician_id        TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  diagnosis            TEXT,
  root_cause           TEXT,
  repair_done          TEXT,
  resolution_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (resolution_confirmed IN (0,1)),
  closure_requested_at TEXT,
  closure_confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,  -- station manager
  closure_confirmed_at TEXT,
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','CLOSURE_REQUESTED','CONFIRMED','REOPENED')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS job_card_spares (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  job_card_id     TEXT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  rate_item_id    TEXT REFERENCES rate_items(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  qty             REAL NOT NULL DEFAULT 1,
  unit_rate_minor INTEGER,
  currency        TEXT NOT NULL DEFAULT 'KES',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS pm_checklist_results (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id           TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  work_order_id    TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  pm_occurrence_id TEXT REFERENCES pm_occurrences(id) ON DELETE SET NULL,
  template_item_id TEXT REFERENCES pm_checklist_items(id) ON DELETE SET NULL,
  result           TEXT,
  passed           INTEGER CHECK (passed IN (0,1)),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 12  MILEAGE  (workflow 3: 1 claim referenced to one station costing)
-- ============================================================================

CREATE TABLE IF NOT EXISTS mileage_claims (
  id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  lpo_id                  TEXT REFERENCES lpos(id) ON DELETE CASCADE,
  work_order_id           TEXT REFERENCES work_orders(id) ON DELETE CASCADE,
  base_station_id         TEXT REFERENCES stations(id) ON DELETE SET NULL,
  referenced_to_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  distance_km             REAL NOT NULL DEFAULT 0,
  rate_per_km_minor       INTEGER NOT NULL DEFAULT 0,
  amount_minor            INTEGER NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL DEFAULT 'KES',
  status                  TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 13  COSTING  (workflow 5, part 1: two approval levels)
-- ============================================================================

CREATE TABLE IF NOT EXISTS work_costs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  work_order_id  TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  contractor_id  TEXT NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  costing_basis  TEXT NOT NULL DEFAULT 'AGREED_RATES'
                   CHECK (costing_basis IN ('AGREED_RATES','QUOTE','MANUAL')),
  quote_id       TEXT REFERENCES quotes(id) ON DELETE SET NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  mileage_minor  INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'KES',
  current_level  INTEGER NOT NULL DEFAULT 0,               -- 0 draft, 1, 2
  recallable     INTEGER NOT NULL DEFAULT 1 CHECK (recallable IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','SUBMITTED','PENDING_L1','PENDING_L2',
                                     'APPROVED','REJECTED','RECALLED')),
  submitted_at   TEXT,
  approved_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS work_cost_items (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  cost_id         TEXT NOT NULL REFERENCES work_costs(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'MANUAL'
                    CHECK (source IN ('PRICE_LIST','QUOTE','MANUAL')),
  rate_item_id    TEXT REFERENCES rate_items(id) ON DELETE SET NULL,
  category_id     TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  unit            TEXT,
  qty             REAL NOT NULL DEFAULT 1,
  unit_rate_minor INTEGER NOT NULL DEFAULT 0,
  amount_minor    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cost_approvals (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  cost_id     TEXT NOT NULL REFERENCES work_costs(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL CHECK (level IN (1,2)),
  approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision    TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  comment     TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (cost_id, level)
);

-- ============================================================================
-- SECTION 14  BILLING  (workflow 5, part 2: three approval levels)
-- ============================================================================

CREATE TABLE IF NOT EXISTS bills (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contractor_id  TEXT NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  bill_no        TEXT NOT NULL,
  period_label   TEXT,                                     -- e.g. 2026-06
  period_start   TEXT,
  period_end     TEXT,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'KES',
  current_level  INTEGER NOT NULL DEFAULT 0,               -- 0 draft, 1 eng, 2 eng mgr, 3 fc
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','SUBMITTED','PENDING_L1_ENG',
                     'PENDING_L2_ENG_MGR','PENDING_L3_FC','APPROVED_READY_FOR_PAYMENT',
                     'REJECTED','PAID')),
  submitted_at   TEXT,
  approved_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, bill_no)
);

CREATE TABLE IF NOT EXISTS bill_costs (
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  cost_id      TEXT NOT NULL REFERENCES work_costs(id) ON DELETE RESTRICT,
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bill_id, cost_id)
);

CREATE TABLE IF NOT EXISTS bill_approvals (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  bill_id     TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL CHECK (level IN (1,2,3)),   -- 1 eng, 2 eng mgr, 3 fc
  approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision    TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  comment     TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (bill_id, level)
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'KES',
  method       TEXT,                                        -- BANK, MPESA, CHEQUE
  reference    TEXT,
  paid_at      TEXT,
  recorded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'RECORDED'
                 CHECK (status IN ('RECORDED','RECONCILED','REVERSED')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- SECTION 15  CROSS-CUTTING: ATTACHMENTS, NOTIFICATIONS, AUDIT, SETTINGS
-- ============================================================================

-- Polymorphic attachments (photo/video on requests, invoices on bills, etc).
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                                -- service_request, bill, job_card
  entity_id   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'DOCUMENT'
                CHECK (kind IN ('PHOTO','VIDEO','INVOICE','DOCUMENT','OTHER')),
  file_name   TEXT NOT NULL,
  file_key    TEXT,                                         -- R2 object key
  file_url    TEXT,
  mime_type   TEXT,
  size_bytes  INTEGER,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL CHECK (channel IN ('SMS','EMAIL','IN_APP')),
  recipient_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipient_contractor_id TEXT REFERENCES contractors(id) ON DELETE SET NULL,
  recipient_technician_id TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  to_address            TEXT,
  template_key          TEXT,
  subject               TEXT,
  body                  TEXT,
  entity_type           TEXT,
  entity_id             TEXT,
  status                TEXT NOT NULL DEFAULT 'QUEUED'
                          CHECK (status IN ('QUEUED','SENT','FAILED','READ')),
  error                 TEXT,
  sent_at               TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,                               -- workorder.assign, cost.approve
  entity_type  TEXT,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id     TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,                                 -- mileage_rate_per_km, approval_thresholds
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, key)
);

-- ============================================================================
-- SECTION 16  INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_subscriptions_org        ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_users_org                ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role          ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_org                ON roles(org_id);
CREATE INDEX IF NOT EXISTS idx_stations_org             ON stations(org_id);
CREATE INDEX IF NOT EXISTS idx_stations_mgr             ON stations(station_manager_id);
CREATE INDEX IF NOT EXISTS idx_assets_org_station       ON assets(org_id, station_id);
CREATE INDEX IF NOT EXISTS idx_engassign_engineer       ON engineer_assignments(engineer_user_id);
CREATE INDEX IF NOT EXISTS idx_contractors_org          ON contractors(org_id);
CREATE INDEX IF NOT EXISTS idx_technicians_contractor   ON technicians(contractor_id);
CREATE INDEX IF NOT EXISTS idx_rate_items_card          ON rate_items(rate_card_id);
CREATE INDEX IF NOT EXISTS idx_requests_org_status      ON service_requests(org_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_station         ON service_requests(station_id);
CREATE INDEX IF NOT EXISTS idx_requests_engineer        ON service_requests(assigned_engineer_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_org_status          ON rfqs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_rfq_inv_rfq              ON rfq_invitations(rfq_id);
CREATE INDEX IF NOT EXISTS idx_quotes_rfq               ON quotes(rfq_id);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote        ON quote_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_pm_schedules_org         ON pm_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_pm_schedules_due         ON pm_schedules(next_due_date);
CREATE INDEX IF NOT EXISTS idx_pm_occ_schedule          ON pm_occurrences(pm_schedule_id);
CREATE INDEX IF NOT EXISTS idx_pm_occ_due_status        ON pm_occurrences(org_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_lpos_org                 ON lpos(org_id);
CREATE INDEX IF NOT EXISTS idx_wo_org_status            ON work_orders(org_id, status);
CREATE INDEX IF NOT EXISTS idx_wo_request              ON work_orders(request_id);
CREATE INDEX IF NOT EXISTS idx_wo_lpo                   ON work_orders(lpo_id);
CREATE INDEX IF NOT EXISTS idx_wo_contractor            ON work_orders(contractor_id);
CREATE INDEX IF NOT EXISTS idx_wo_technician            ON work_orders(technician_id);
CREATE INDEX IF NOT EXISTS idx_jsa_wo                   ON job_safety_analyses(work_order_id);
CREATE INDEX IF NOT EXISTS idx_arrivals_wo              ON site_arrivals(work_order_id);
CREATE INDEX IF NOT EXISTS idx_jobcards_wo              ON job_cards(work_order_id);
CREATE INDEX IF NOT EXISTS idx_spares_jobcard           ON job_card_spares(job_card_id);
CREATE INDEX IF NOT EXISTS idx_pmresults_wo             ON pm_checklist_results(work_order_id);
CREATE INDEX IF NOT EXISTS idx_mileage_lpo              ON mileage_claims(lpo_id);
CREATE INDEX IF NOT EXISTS idx_costs_org_status         ON work_costs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_costs_wo                 ON work_costs(work_order_id);
CREATE INDEX IF NOT EXISTS idx_cost_items_cost          ON work_cost_items(cost_id);
CREATE INDEX IF NOT EXISTS idx_cost_appr_cost           ON cost_approvals(cost_id);
CREATE INDEX IF NOT EXISTS idx_bills_org_status         ON bills(org_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_contractor         ON bills(contractor_id);
CREATE INDEX IF NOT EXISTS idx_bill_costs_cost          ON bill_costs(cost_id);
CREATE INDEX IF NOT EXISTS idx_bill_appr_bill           ON bill_approvals(bill_id);
CREATE INDEX IF NOT EXISTS idx_payments_bill            ON payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity       ON attachments(org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status     ON notifications(org_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity             ON audit_logs(org_id, entity_type, entity_id);

-- ============================================================================
-- SECTION 17  DASHBOARD VIEWS
-- ============================================================================

CREATE VIEW IF NOT EXISTS v_open_work_orders AS
SELECT wo.id, wo.org_id, wo.wo_no, wo.status, wo.station_id, s.name AS station_name,
       wo.contractor_id, c.name AS contractor_name, wo.sla_id, wo.created_at
FROM work_orders wo
LEFT JOIN stations s    ON s.id = wo.station_id
LEFT JOIN contractors c ON c.id = wo.contractor_id
WHERE wo.status NOT IN ('CLOSED','CANCELLED') AND wo.deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS v_pending_cost_approvals AS
SELECT wc.id, wc.org_id, wc.work_order_id, wc.contractor_id, wc.total_minor,
       wc.currency, wc.current_level, wc.status, wc.submitted_at
FROM work_costs wc
WHERE wc.status IN ('SUBMITTED','PENDING_L1','PENDING_L2');

CREATE VIEW IF NOT EXISTS v_pending_bill_approvals AS
SELECT b.id, b.org_id, b.contractor_id, b.bill_no, b.total_minor, b.currency,
       b.current_level, b.status, b.submitted_at
FROM bills b
WHERE b.status IN ('SUBMITTED','PENDING_L1_ENG','PENDING_L2_ENG_MGR','PENDING_L3_FC');

CREATE VIEW IF NOT EXISTS v_upcoming_pm AS
SELECT po.id, po.org_id, po.pm_schedule_id, ps.name AS schedule_name,
       po.due_date, po.status
FROM pm_occurrences po
JOIN pm_schedules ps ON ps.id = po.pm_schedule_id
WHERE po.status NOT IN ('COMPLETED','MISSED');

-- ============================================================================
-- SECTION 18  updated_at TRIGGERS
-- Recursive triggers are off by default in libSQL, so these do not loop.
-- The WHEN guard skips the write when the app already set updated_at.
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_organisations_updated
AFTER UPDATE ON organisations FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE organisations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_updated
AFTER UPDATE ON subscriptions FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_users_updated
AFTER UPDATE ON users FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_stations_updated
AFTER UPDATE ON stations FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE stations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_assets_updated
AFTER UPDATE ON assets FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE assets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_requests_updated
AFTER UPDATE ON service_requests FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE service_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_rfqs_updated
AFTER UPDATE ON rfqs FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE rfqs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_quotes_updated
AFTER UPDATE ON quotes FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE quotes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pm_schedules_updated
AFTER UPDATE ON pm_schedules FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE pm_schedules SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_work_orders_updated
AFTER UPDATE ON work_orders FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE work_orders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_work_costs_updated
AFTER UPDATE ON work_costs FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE work_costs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_bills_updated
AFTER UPDATE ON bills FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE bills SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;

-- End of schema.
