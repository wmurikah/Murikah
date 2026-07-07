-- Hass CMS schema snapshot.
-- Introspected from the live Turso CMS database (SELECT sql FROM sqlite_master)
-- on 2026-07-07. This is the ground truth the typed column layer
-- (src/lib/cms/schema/columns.ts) is generated from: a query that names a column
-- not present here fails `pnpm build`, never at runtime. Regenerate with
-- cms/db/introspect.mjs when the live schema changes; keep this and schema.md in step.
-- No FTS shadow tables are present in this database.

CREATE TABLE approval_requests (
  request_id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES approval_workflows(workflow_id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  country_code TEXT,
  amount REAL,
  currency_code TEXT,
  tier TEXT,                                          -- LOW | MID | HIGH
  required_role_codes TEXT,                           -- CSV of role_codes eligible to approve
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_to TEXT REFERENCES users(user_id),
  status TEXT NOT NULL DEFAULT 'PENDING',             -- PENDING | APPROVED | REJECTED | ESCALATED | EXPIRED
  approved_by TEXT,
  approved_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  sla_due_at TEXT,
  comments TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE approval_workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,                          -- 'order' | 'credit' | 'refund' | etc
  rules_json TEXT NOT NULL,                           -- JSON rule definition
  country_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  log_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  actor_email TEXT,
  actor_ip TEXT,
  actor_user_agent TEXT,
  before_json TEXT,
  after_json TEXT,
  metadata TEXT,
  country_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bot_conversations (  turn_id TEXT PRIMARY KEY,  session_id TEXT,  user_id TEXT NOT NULL,  user_role TEXT,  config_id TEXT REFERENCES bot_llm_configs(config_id),  user_message TEXT NOT NULL,  bot_response TEXT,  tool_calls_json TEXT,  tokens_used INTEGER,  latency_ms INTEGER,  status TEXT NOT NULL DEFAULT 'OK',  error_message TEXT,  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE bot_llm_configs (  config_id TEXT PRIMARY KEY,  provider TEXT NOT NULL,  label TEXT NOT NULL,  model TEXT NOT NULL,  endpoint_url TEXT,  api_key_property TEXT NOT NULL,  max_tokens INTEGER NOT NULL DEFAULT 1024,  temperature REAL NOT NULL DEFAULT 0.3,  system_prompt TEXT,  is_active INTEGER NOT NULL DEFAULT 0,  is_default INTEGER NOT NULL DEFAULT 0,  allowed_roles TEXT,  notes TEXT,  created_by TEXT,  created_at TEXT NOT NULL DEFAULT (datetime('now')),  updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE bot_tools (  tool_id TEXT PRIMARY KEY,  service TEXT NOT NULL,  action TEXT NOT NULL,  description TEXT NOT NULL,  params_schema_json TEXT,  is_write INTEGER NOT NULL DEFAULT 0,  required_permission TEXT,  is_enabled INTEGER NOT NULL DEFAULT 1,  created_at TEXT NOT NULL DEFAULT (datetime('now'))  , UNIQUE(service, action));

CREATE TABLE branding (
  scope_code TEXT PRIMARY KEY,                        -- 'GLOBAL' or country_code
  app_name TEXT NOT NULL,
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  accent_color TEXT,
  extra_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE business_hours (
  hours_id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  monday_start TEXT, monday_end TEXT,
  tuesday_start TEXT, tuesday_end TEXT,
  wednesday_start TEXT, wednesday_end TEXT,
  thursday_start TEXT, thursday_end TEXT,
  friday_start TEXT, friday_end TEXT,
  saturday_start TEXT, saturday_end TEXT,
  sunday_start TEXT, sunday_end TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE churn_risk_factors (
  factor_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  factor_type TEXT,
  factor_weight REAL NOT NULL DEFAULT 1.0,
  current_value TEXT,
  previous_value TEXT,
  threshold TEXT,
  score REAL NOT NULL DEFAULT 0,
  notes TEXT,
  recorded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT,
  value_type TEXT NOT NULL DEFAULT 'STRING',          -- STRING | NUMBER | BOOL | JSON
  description TEXT,
  country_code TEXT,                                  -- NULL = global; else override
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contacts (
  contact_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  phone_alt TEXT,
  job_title TEXT,
  department TEXT,
  contact_type TEXT NOT NULL DEFAULT 'PRIMARY',
  is_decision_maker INTEGER NOT NULL DEFAULT 0,
  is_portal_user INTEGER NOT NULL DEFAULT 1,
  portal_role TEXT NOT NULL DEFAULT 'VIEWER'
    CHECK (portal_role IN ('ADMIN','MANAGER','OPERATOR','VIEWER')),
  password_hash TEXT,                                 -- pbkdf2$ format
  auth_provider TEXT NOT NULL DEFAULT 'LOCAL',        -- LOCAL | GOOGLE | MICROSOFT
  auth_uid TEXT,                                      -- external SSO subject id, if not LOCAL
  password_changed_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  notification_email INTEGER NOT NULL DEFAULT 1,
  notification_sms INTEGER NOT NULL DEFAULT 0,
  notification_whatsapp INTEGER NOT NULL DEFAULT 0,
  notification_push INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE countries (
  country_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  affiliate_code TEXT NOT NULL UNIQUE,
  currency_code TEXT NOT NULL,
  currency_symbol TEXT,
  timezone TEXT NOT NULL,
  dialing_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL UNIQUE,                -- aligned to Oracle master
  oracle_customer_code TEXT,
  company_name TEXT NOT NULL,
  trading_name TEXT,
  customer_type TEXT NOT NULL DEFAULT 'B2B'
    CHECK (customer_type IN ('B2B','B2C','GOVERNMENT')),
  segment_id TEXT REFERENCES segments(segment_id),
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  affiliate_code TEXT,
  currency_code TEXT,
  email TEXT,                                         -- company main email
  phone TEXT,
  address TEXT,
  city TEXT,
  industry TEXT,
  website TEXT,
  tax_pin TEXT,
  registration_number TEXT,
  credit_limit REAL DEFAULT 0,
  credit_used REAL DEFAULT 0,
  payment_terms INTEGER DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  onboarding_status TEXT NOT NULL DEFAULT 'COMPLETE',
  risk_score REAL DEFAULT 0,
  risk_level TEXT DEFAULT 'LOW',
  lifetime_value REAL DEFAULT 0,
  relationship_owner_id TEXT REFERENCES users(user_id),
  parent_customer_id TEXT REFERENCES customers(customer_id),
  source TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE delivery_locations (
  location_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  country_code TEXT REFERENCES countries(country_code),
  postal_code TEXT,
  latitude REAL,
  longitude REAL,
  delivery_instructions TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  access_hours TEXT,
  requires_appointment INTEGER NOT NULL DEFAULT 0,
  tank_capacity REAL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE depots (
  depot_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  city TEXT,
  address TEXT,
  depot_type TEXT NOT NULL DEFAULT 'STORAGE',
  capacity REAL,
  products_available TEXT,                            -- JSON array of product_ids
  contact_phone TEXT,
  contact_email TEXT,
  latitude REAL,
  longitude REAL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  document_type TEXT NOT NULL,
  name TEXT,
  file_id TEXT,
  file_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  document_number TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  issuing_authority TEXT,
  is_mandatory INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  rejection_reason TEXT,
  reminder_sent_at TEXT,
  uploaded_by_type TEXT,
  uploaded_by_id TEXT,
  verified_by TEXT,
  verified_at TEXT,
  verification_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  previous_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE drivers (
  driver_id TEXT PRIMARY KEY,
  employee_id TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  license_number TEXT,
  license_expiry TEXT,
  country_code TEXT REFERENCES countries(country_code),
  depot_id TEXT REFERENCES depots(depot_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE entity_statuses (
  entity TEXT NOT NULL,
  status_code TEXT NOT NULL,
  label_key TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, status_code)
);

CREATE TABLE escalation_paths (
  path_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                                -- 'TICKET' | 'APPROVAL'
  category TEXT NOT NULL DEFAULT 'ALL',
  level INTEGER NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(role_code),
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE exchange_rates (
  rate_id TEXT PRIMARY KEY,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE holidays (
  holiday_id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  name TEXT,
  holiday_date TEXT NOT NULL,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE integration_log (
  log_id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'OUTBOUND',
  endpoint TEXT,
  method TEXT,
  request_body TEXT,
  response_body TEXT,
  status_code INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  reference_type TEXT,
  reference_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invoices (
  invoice_id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  oracle_invoice_id TEXT,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  country_code TEXT REFERENCES countries(country_code),
  currency_code TEXT,
  issue_date TEXT,
  due_date TEXT,
  subtotal REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  paid_amount REAL DEFAULT 0,
  paid_date TEXT,
  payment_method TEXT,
  payment_reference TEXT,
  payment_proof_file_id TEXT,
  etims_invoice_number TEXT,
  etims_qr_url TEXT,
  etims_submitted_at TEXT,
  etims_status TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE job_queue (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'PENDING',             -- PENDING | RUNNING | DONE | FAILED
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_articles (
  article_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES knowledge_categories(category_id),
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  summary TEXT,
  content TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  tags TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  is_featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  helpful_yes INTEGER NOT NULL DEFAULT 0,
  helpful_no INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_categories (
  category_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_category_id TEXT REFERENCES knowledge_categories(category_id),
  is_public INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE localization (
  string_key TEXT NOT NULL,
  locale TEXT NOT NULL,                               -- 'en' | 'sw' | 'fr'
  value TEXT NOT NULL,
  PRIMARY KEY (string_key, locale)
);

CREATE TABLE menu_items (
  item_code TEXT PRIMARY KEY,
  parent_code TEXT,
  audience TEXT NOT NULL,                             -- STAFF | PORTAL
  label_key TEXT NOT NULL,                            -- references localization.string_key
  icon TEXT,
  route TEXT NOT NULL,                                -- partial name e.g. 'orders'
  sort_order INTEGER NOT NULL DEFAULT 100,
  required_permission TEXT,                           -- references permissions.permission_code
  role_scope TEXT,                                    -- optional CSV of role_code values
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mfa_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('STAFF','CUSTOMER')),
  user_id TEXT NOT NULL,
  role TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('enroll','verify')),
  pending_secret TEXT,                                -- only used during enrol; cleared on consume
  fails INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notification_preferences (
  preference_id TEXT PRIMARY KEY,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  channel_email INTEGER NOT NULL DEFAULT 1,
  channel_sms INTEGER NOT NULL DEFAULT 0,
  channel_whatsapp INTEGER NOT NULL DEFAULT 0,
  channel_push INTEGER NOT NULL DEFAULT 0,
  channel_in_app INTEGER NOT NULL DEFAULT 1,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notification_templates (
  template_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,                              -- EMAIL | SMS | WHATSAPP | IN_APP
  language TEXT NOT NULL DEFAULT 'en',
  subject TEXT,
  body_html TEXT,
  body_text TEXT,
  variables TEXT,
  country_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  title TEXT NOT NULL,
  message TEXT,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  email_sent INTEGER NOT NULL DEFAULT 0,
  sms_sent INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  in_app_read_at TEXT,
  action_url TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE order_lines (
  line_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  product_name TEXT,
  quantity REAL NOT NULL,
  unit_of_measure TEXT NOT NULL DEFAULT 'LITERS',
  unit_price REAL DEFAULT 0,
  discount_percent REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  line_subtotal REAL DEFAULT 0,
  line_tax REAL DEFAULT 0,
  line_total REAL DEFAULT 0,
  delivered_quantity REAL,
  delivery_variance_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE order_status_history (
  history_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by_type TEXT,
  changed_by_id TEXT,
  changed_by_name TEXT,
  notes TEXT,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  oracle_order_id TEXT,
  po_number TEXT,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  contact_id TEXT REFERENCES contacts(contact_id),
  delivery_location_id TEXT REFERENCES delivery_locations(location_id),
  source_depot_id TEXT REFERENCES depots(depot_id),
  price_list_id TEXT,
  country_code TEXT REFERENCES countries(country_code),
  currency_code TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  requested_date TEXT,
  requested_time_from TEXT,
  requested_time_to TEXT,
  confirmed_date TEXT,
  confirmed_time TEXT,
  subtotal REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  delivery_fee REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  special_instructions TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_schedule_id TEXT,
  vehicle_id TEXT REFERENCES vehicles(vehicle_id),
  driver_id TEXT REFERENCES drivers(driver_id),
  submitted_at TEXT,
  approved_at TEXT,
  approved_by TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancelled_reason TEXT,
  delivery_notes TEXT,
  delivery_confirmed_by TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  created_by_type TEXT,
  created_by_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE password_history (
  history_id TEXT PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('STAFF','CUSTOMER')),
  user_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE password_resets (
  reset_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK (user_type IN ('STAFF','CUSTOMER')),
  user_id TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payment_uploads (
  upload_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  order_id TEXT REFERENCES orders(order_id),
  invoice_id TEXT REFERENCES invoices(invoice_id),
  file_id TEXT,
  file_path TEXT,
  file_name TEXT,
  payment_method TEXT,
  amount REAL,
  currency_code TEXT,
  reference_number TEXT,
  upload_date TEXT,
  uploaded_by TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE permissions (
  permission_code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE po_approvals (
  purchase_number TEXT,
  req_description TEXT,
  nature TEXT,
  original_creation_date TEXT,
  submission_for_approval_date TEXT,
  time_diff_raisepo_toaprovalsubmit REAL,
  purchase_order_created_by TEXT,
  first_approval_date TEXT,
  second_approval_date TEXT,
  third_approval_date TEXT,
  fourth_approval_date TEXT,
  fifth_approval_date TEXT,
  sixth_approval_date TEXT,
  seventh_approval_date TEXT,
  first_approver TEXT,
  second_approver TEXT,
  third_approver TEXT,
  fourth_approver TEXT,
  fifth_approver TEXT,
  sixth_approver TEXT,
  seventh_approver TEXT,
  first_approvals_variance REAL,
  second_approvals_variance REAL,
  third_approvals_variance REAL,
  fourth_approvals_variance REAL,
  fifth_approvals_variance REAL,
  sixth_approvals_variance REAL,
  seventh_approvals_variance REAL,
  authorization_status TEXT,
  source TEXT NOT NULL DEFAULT 'UPLOAD',
  source_batch_id TEXT,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (purchase_number)
);

CREATE TABLE po_so_comments ( comment_id TEXT PRIMARY KEY, doc_type TEXT, doc_number TEXT, author_id TEXT, author_name TEXT, recipient TEXT, body TEXT NOT NULL, email_sent INTEGER NOT NULL DEFAULT 0, email_sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE price_list (
  price_id TEXT PRIMARY KEY,
  name TEXT,
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  currency_code TEXT,
  segment_id TEXT REFERENCES segments(segment_id),
  customer_id TEXT REFERENCES customers(customer_id),
  is_default INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE price_list_items (
  item_id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_list(price_id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  depot_id TEXT REFERENCES depots(depot_id),
  unit_price REAL NOT NULL,
  min_quantity REAL DEFAULT 0,
  max_quantity REAL,
  discount_percent REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  subcategory TEXT,
  unit_of_measure TEXT NOT NULL DEFAULT 'LITERS',
  min_order_quantity REAL DEFAULT 0,
  max_order_quantity REAL,
  requires_special_handling INTEGER NOT NULL DEFAULT 0,
  handling_instructions TEXT,
  image_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recurring_schedule (
  schedule_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  name TEXT,
  delivery_location_id TEXT REFERENCES delivery_locations(location_id),
  frequency TEXT NOT NULL DEFAULT 'WEEKLY',
  frequency_interval INTEGER NOT NULL DEFAULT 1,
  day_of_week INTEGER,
  day_of_month INTEGER,
  preferred_time_from TEXT,
  preferred_time_to TEXT,
  start_date TEXT,
  end_date TEXT,
  next_order_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  auto_submit INTEGER NOT NULL DEFAULT 0,
  special_instructions TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recurring_schedule_lines (
  line_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES recurring_schedule(schedule_id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  quantity REAL NOT NULL,
  unit_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE retention_activities (
  activity_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  activity_type TEXT,
  subject TEXT,
  description TEXT,
  outcome TEXT,
  next_action TEXT,
  next_action_date TEXT,
  performed_by TEXT,
  performed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(role_code),
  permission_code TEXT NOT NULL REFERENCES permissions(permission_code),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE roles (
  role_code TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'COUNTRY' CHECK (scope IN ('GLOBAL','COUNTRY')),
  is_system INTEGER NOT NULL DEFAULT 0,
  mfa_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  sla_multiplier REAL NOT NULL DEFAULT 1.0,
  credit_multiplier REAL NOT NULL DEFAULT 1.0,
  priority_level INTEGER NOT NULL DEFAULT 99,
  color TEXT,
  min_volume REAL DEFAULT 0,
  max_volume REAL,
  credit_terms_days INTEGER DEFAULT 30,
  discount_percentage REAL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('STAFF','CUSTOMER')),
  user_id TEXT NOT NULL,                              -- users.user_id or contacts.contact_id
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  country_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 30,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, role TEXT);

CREATE TABLE signup_requests (
  request_id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  job_title TEXT,
  account_type TEXT,
  customer_id TEXT,
  country_code TEXT,
  tax_pin TEXT,
  registration_number TEXT,
  certificate_of_incorporation TEXT,
  dealer_code TEXT,                                   -- fuel-retail dealer onboarding
  station_name TEXT,
  card_number TEXT,
  kra_pin TEXT,                                       -- Kenya tax PIN, kept separate from generic tax_pin
  account_number TEXT,
  company_address TEXT,
  pending_password_hash TEXT,                         -- pbkdf2 format, cleared on approval
  kyc_status TEXT NOT NULL DEFAULT 'PENDING',
  status TEXT NOT NULL DEFAULT 'PENDING',
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  rejected_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
, reviewed_by TEXT, reviewed_at TEXT, decision_reason TEXT, provisioned_id TEXT, provisioned_type TEXT);

CREATE TABLE sla_config (
  sla_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'ALL',
  segment_id TEXT NOT NULL DEFAULT 'ALL',
  category TEXT NOT NULL DEFAULT 'ALL',
  priority TEXT NOT NULL,
  channel TEXT,
  process_type TEXT NOT NULL DEFAULT 'TICKET',
  acknowledge_minutes INTEGER NOT NULL DEFAULT 15,
  response_minutes INTEGER NOT NULL DEFAULT 60,
  resolve_minutes INTEGER NOT NULL DEFAULT 480,
  escalation_1_minutes INTEGER NOT NULL DEFAULT 120,
  escalation_2_minutes INTEGER NOT NULL DEFAULT 240,
  escalation_3_minutes INTEGER NOT NULL DEFAULT 480,
  business_hours_only INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT,
  effective_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE so_approvals (
  affiliate TEXT,
  document_number TEXT,
  posting_date TEXT,
  actual_order_date_user_input TEXT,
  customer_code TEXT,
  customer_name TEXT,
  user_name TEXT,
  create_date TEXT,
  create_time TEXT,
  create_date_time TEXT,
  approval_date1 TEXT,
  approval_date TEXT,
  approval_time TEXT,
  approval_date_time TEXT,
  finance_variance REAL,
  delayed_raising_orders REAL,
  approval_status TEXT,
  approver TEXT,
  credit_hold_date TEXT,
  credit_hold_name TEXT,
  released_flag TEXT,
  release_reason_code TEXT,
  credit_hold_release_date TEXT,
  hold_released_by TEXT,
  credit_variance REAL,
  invoice_creation_date TEXT,
  invoice_variance REAL,
  line_number INTEGER,
  ordered_item TEXT,
  loading_authority_date TEXT,
  loading_authority_variance REAL,
  source TEXT NOT NULL DEFAULT 'UPLOAD',
  source_batch_id TEXT,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_number, line_number)
);

CREATE TABLE staff_messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'GROUP',
  sender_id TEXT NOT NULL REFERENCES users(user_id),
  sender_name TEXT,
  content TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 1,
  read_by TEXT,
  parent_message_id TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE status_transitions (
  entity TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  required_permission TEXT,
  action_label_key TEXT,
  PRIMARY KEY (entity, from_status, to_status)
);

CREATE TABLE teams (
  team_id TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  department TEXT,
  country_code TEXT REFERENCES countries(country_code),
  team_lead_id TEXT,                                  -- references users.user_id (no FK due to creation order)
  parent_team_id TEXT REFERENCES teams(team_id),
  escalation_team_id TEXT REFERENCES teams(team_id),
  auto_assign INTEGER NOT NULL DEFAULT 0,
  assignment_method TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
  working_hours TEXT,
  timezone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ticket_attachments (
  attachment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  comment_id TEXT REFERENCES ticket_comments(comment_id),
  file_name TEXT NOT NULL,
  file_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_by_type TEXT,
  uploaded_by_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ticket_comments (
  comment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  parent_comment_id TEXT,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  content TEXT NOT NULL,
  content_html TEXT,
  is_internal INTEGER NOT NULL DEFAULT 0,
  is_resolution INTEGER NOT NULL DEFAULT 0,
  channel TEXT,
  external_message_id TEXT,
  sentiment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ticket_history (
  history_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_by_type TEXT,
  changed_by_id TEXT,
  changed_by_name TEXT,
  change_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  contact_id TEXT REFERENCES contacts(contact_id),
  channel TEXT NOT NULL DEFAULT 'PORTAL',
  category TEXT,
  subcategory TEXT,
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status TEXT NOT NULL DEFAULT 'NEW',
  assigned_to TEXT REFERENCES users(user_id),
  assigned_team_id TEXT REFERENCES teams(team_id),
  related_order_id TEXT REFERENCES orders(order_id),
  country_code TEXT REFERENCES countries(country_code),
  sla_config_id TEXT REFERENCES sla_config(sla_id),
  sla_acknowledge_by TEXT,
  sla_response_by TEXT,
  sla_resolve_by TEXT,
  sla_acknowledge_breached INTEGER NOT NULL DEFAULT 0,
  sla_response_breached INTEGER NOT NULL DEFAULT 0,
  sla_resolve_breached INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  first_response_at TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  resolution_type TEXT,
  resolution_summary TEXT,
  root_cause TEXT,
  root_cause_category TEXT,
  satisfaction_rating INTEGER,
  satisfaction_comment TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_to TEXT REFERENCES users(user_id),
  escalated_at TEXT,
  escalation_reason TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  last_reopened_at TEXT,
  merged_into_id TEXT REFERENCES tickets(ticket_id),
  tags TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  role_code TEXT NOT NULL REFERENCES roles(role_code),
  assigned_by TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  employee_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  avatar_url TEXT,
  department TEXT,
  country_code TEXT REFERENCES countries(country_code),
  countries_access TEXT,                              -- CSV of country_codes for multi-country roles
  team_id TEXT REFERENCES teams(team_id),
  reports_to TEXT REFERENCES users(user_id),
  max_tickets INTEGER NOT NULL DEFAULT 20,
  password_hash TEXT NOT NULL,                        -- pbkdf2$iter$salt$hash
  password_changed_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | LOCKED | DISABLED
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vehicles (
  vehicle_id TEXT PRIMARY KEY,
  registration_number TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL DEFAULT 'TANKER',
  capacity REAL,
  capacity_unit TEXT NOT NULL DEFAULT 'LITERS',
  country_code TEXT REFERENCES countries(country_code),
  depot_id TEXT REFERENCES depots(depot_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_service_date TEXT,
  next_service_date TEXT,
  gps_device_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX ix_approval_assigned ON approval_requests(assigned_to, status);
CREATE INDEX ix_approval_entity ON approval_requests(entity_type, entity_id);
CREATE INDEX ix_audit_actor ON audit_log(actor_id);
CREATE INDEX ix_audit_created ON audit_log(created_at);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_churn_customer ON churn_risk_factors(customer_id);
CREATE INDEX ix_config_country ON config(country_code);
CREATE INDEX ix_contacts_customer ON contacts(customer_id);
CREATE INDEX ix_contacts_email ON contacts(email);
CREATE INDEX ix_customers_country ON customers(country_code);
CREATE INDEX ix_customers_oracle ON customers(oracle_customer_code);
CREATE INDEX ix_customers_segment ON customers(segment_id);
CREATE INDEX ix_customers_status ON customers(status);
CREATE INDEX ix_documents_customer ON documents(customer_id);
CREATE INDEX ix_documents_expiry ON documents(expiry_date);
CREATE INDEX ix_documents_status ON documents(status);
CREATE INDEX ix_escalation_scope ON escalation_paths(scope, category, level);
CREATE INDEX ix_intlog_integration ON integration_log(integration, created_at);
CREATE INDEX ix_invoices_customer ON invoices(customer_id);
CREATE INDEX ix_invoices_order ON invoices(order_id);
CREATE INDEX ix_invoices_status ON invoices(payment_status);
CREATE INDEX ix_jobq_status ON job_queue(status, next_run_at);
CREATE INDEX ix_locations_customer ON delivery_locations(customer_id);
CREATE INDEX ix_menu_audience ON menu_items(audience, is_active, sort_order);
CREATE INDEX ix_mfa_user ON mfa_challenges(user_id, consumed_at);
CREATE INDEX ix_notif_recipient ON notifications(recipient_id, is_read);
CREATE INDEX ix_notifpref_recipient ON notification_preferences(recipient_id);
CREATE INDEX ix_orderhistory_order ON order_status_history(order_id);
CREATE INDEX ix_orderlines_order ON order_lines(order_id);
CREATE INDEX ix_orders_country ON orders(country_code);
CREATE INDEX ix_orders_created ON orders(created_at);
CREATE INDEX ix_orders_customer ON orders(customer_id);
CREATE INDEX ix_orders_status ON orders(status);
CREATE INDEX ix_password_history_user ON password_history(user_id, created_at);
CREATE INDEX ix_password_resets_email ON password_resets(email);
CREATE INDEX ix_payments_customer ON payment_uploads(customer_id);
CREATE INDEX ix_payments_status ON payment_uploads(status);
CREATE INDEX ix_po_createdby ON po_approvals(purchase_order_created_by);
CREATE INDEX ix_po_status   ON po_approvals(authorization_status);
CREATE INDEX ix_pricelist_country ON price_list(country_code);
CREATE INDEX ix_pricelist_status ON price_list(status);
CREATE INDEX ix_rates_pair ON exchange_rates(from_currency, to_currency, effective_from);
CREATE INDEX ix_recurring_customer ON recurring_schedule(customer_id);
CREATE INDEX ix_retention_customer ON retention_activities(customer_id);
CREATE INDEX ix_sessions_active ON sessions(is_active, expires_at);
CREATE INDEX ix_sessions_token ON sessions(token_hash);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_signup_email ON signup_requests(email);
CREATE INDEX ix_signup_status ON signup_requests(status);
CREATE INDEX ix_so_approver  ON so_approvals(approver);
CREATE INDEX ix_so_customer  ON so_approvals(customer_code);
CREATE INDEX ix_so_doc       ON so_approvals(document_number);
CREATE INDEX ix_staff_messages_room ON staff_messages(room_id, created_at);
CREATE INDEX ix_tcomments_ticket ON ticket_comments(ticket_id);
CREATE INDEX ix_teams_active ON teams(is_active);
CREATE INDEX ix_teams_country ON teams(country_code);
CREATE INDEX ix_tickets_assigned ON tickets(assigned_to);
CREATE INDEX ix_tickets_country ON tickets(country_code);
CREATE INDEX ix_tickets_customer ON tickets(customer_id);
CREATE INDEX ix_tickets_status ON tickets(status);
CREATE INDEX ix_user_roles_user ON user_roles(user_id);
CREATE INDEX ix_users_country ON users(country_code);
CREATE INDEX ix_users_email ON users(email);
CREATE INDEX ix_users_status ON users(status);
CREATE UNIQUE INDEX ux_price_list_default
  ON price_list (country_code, currency_code)
  WHERE is_default = 1 AND status = 'ACTIVE';
