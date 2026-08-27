/**
 * The DDL the CMS authentication tests create their database from.
 *
 * Copied VERBATIM from the operator's hass_cms_turso_v1_FINAL.sql: the tables
 * on the authentication path, the organisation master data Build Prompt 05
 * administers, the user, workflow-authority and product-catalogue tables Build
 * Prompts 06 to 09 administer, and every table those reach through a foreign
 * key. Constraints are included exactly as written, so a test proves the code
 * satisfies the real CHECK and UNIQUE rules rather than a relaxed copy of them.
 *
 * The order is not strictly topological and does not need to be: SQLite
 * resolves a foreign key when a row is written, not when the table is created,
 * so `teams` and `team_members` may name `users` before it exists here. Foreign
 * keys are enforced at DML time, which is when the tests exercise them.
 *
 * WHY THIS IS A .ts FILE AND NOT THE .sql
 * The authoritative schema was supplied out of band and is not committed here,
 * because Build Prompt 03's acceptance criterion 7 requires that `git diff main`
 * contain no .sql file. That criterion exists to prove the schema was not
 * changed, which it was not: nothing in this phase adds a table, a column, a
 * constraint, an index or a migration.
 *
 * The consequence is worth stating plainly rather than hiding: this copy can
 * drift from the live database, and nothing in CI would notice. Engineering
 * Rhythm and the GRC platform both avoid that by committing their schema as
 * ground truth (engr/db/schema.sql, grc/db/schema.md) and generating from it.
 * The recommendation is that this product does the same once criterion 7 has
 * served its purpose, at which point this file is generated rather than copied.
 */
export const AUTH_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS countries (
    country_id TEXT PRIMARY KEY,
    iso2 TEXT NOT NULL UNIQUE CHECK(length(iso2)=2),
    country_name TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS affiliates (
    affiliate_id TEXT PRIMARY KEY,
    affiliate_code TEXT NOT NULL UNIQUE,
    affiliate_name TEXT NOT NULL,
    country_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_units (
    business_unit_id TEXT PRIMARY KEY,
    business_unit_code TEXT NOT NULL UNIQUE,
    business_unit_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS departments (
    department_id TEXT PRIMARY KEY,
    department_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_titles (
    job_title_id TEXT PRIMARY KEY,
    title_name TEXT NOT NULL UNIQUE,
    department_id TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS teams (
    team_id TEXT PRIMARY KEY,
    team_name TEXT NOT NULL UNIQUE,
    team_type TEXT NOT NULL CHECK(team_type IN ('CUSTOMER_SERVICE','SALES','FINANCE','CREDIT','OPERATIONS','PROCUREMENT','MANAGEMENT','OTHER')),
    affiliate_id TEXT,
    business_unit_id TEXT,
    manager_user_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    FOREIGN KEY (manager_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    team_member_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    member_role TEXT,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    UNIQUE(team_id, user_id, effective_from)
);

CREATE TABLE IF NOT EXISTS access_roles (
    role_id TEXT PRIMARY KEY,
    role_name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_system_role INTEGER NOT NULL DEFAULT 0 CHECK(is_system_role IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS permissions (
    permission_id TEXT PRIMARY KEY,
    module_name TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    action_name TEXT NOT NULL,
    description TEXT,
    UNIQUE(module_name, resource_name, action_name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_permission_id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1 CHECK(allowed IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES access_roles(role_id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE CASCADE,
    UNIQUE(role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    user_type TEXT NOT NULL DEFAULT 'INTERNAL' CHECK(user_type IN ('INTERNAL','EXTERNAL')),
    employee_no TEXT UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(instr(email,'@') > 1),
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('INVITED','ACTIVE','SUSPENDED','INACTIVE')),
    email_verified_at TEXT,
    timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    locale TEXT NOT NULL DEFAULT 'en-KE',
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(status != 'ACTIVE' OR email_verified_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    account_code TEXT UNIQUE,
    account_name TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK(account_type IN ('PROSPECT','CUSTOMER','FORMER_CUSTOMER')),
    oracle_customer_code TEXT UNIQUE,
    industry TEXT,
    segment TEXT,
    country_id TEXT NOT NULL,
    affiliate_id TEXT,
    address TEXT,
    phone TEXT,
    email TEXT COLLATE NOCASE,
    website TEXT,
    tax_pin TEXT,
    credit_limit REAL CHECK(credit_limit IS NULL OR credit_limit >= 0),
    credit_days INTEGER CHECK(credit_days IS NULL OR credit_days >= 0),
    account_manager_user_id TEXT,
    customer_since TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE','BLOCKED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE RESTRICT,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (account_manager_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    contact_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    job_title TEXT,
    email TEXT COLLATE NOCASE,
    phone TEXT,
    whatsapp TEXT,
    preferred_channel TEXT CHECK(preferred_channel IN ('EMAIL','PHONE','WHATSAPP','SMS','OTHER')),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_credentials (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_algorithm TEXT NOT NULL CHECK(password_algorithm IN ('ARGON2ID','BCRYPT','PBKDF2')),
    must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
    password_changed_at TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    device_label TEXT,
    ip_address TEXT,
    user_agent TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CHECK(expires_at >= issued_at)
);

CREATE TABLE IF NOT EXISTS login_attempts (
    login_attempt_id TEXT PRIMARY KEY,
    email_attempted TEXT NOT NULL COLLATE NOCASE,
    user_id TEXT,
    success INTEGER NOT NULL CHECK(success IN (0,1)),
    failure_reason TEXT,
    ip_address TEXT,
    user_agent TEXT,
    attempted_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    audit_event_id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    ip_address TEXT,
    user_agent TEXT,
    event_at TEXT NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_assignments (
    assignment_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_title_id TEXT NOT NULL,
    department_id TEXT NOT NULL,
    assignment_level TEXT NOT NULL CHECK(assignment_level IN ('GROUP','COUNTRY','AFFILIATE','BUSINESS_UNIT')),
    country_id TEXT,
    affiliate_id TEXT,
    business_unit_id TEXT,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (job_title_id) REFERENCES job_titles(job_title_id) ON DELETE RESTRICT,
    FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE SET NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    CHECK(effective_to IS NULL OR effective_to >= effective_from),
    CHECK(
        (assignment_level='GROUP' AND country_id IS NULL AND affiliate_id IS NULL AND business_unit_id IS NULL)
        OR (assignment_level='COUNTRY' AND country_id IS NOT NULL)
        OR (assignment_level='AFFILIATE' AND affiliate_id IS NOT NULL)
        OR (assignment_level='BUSINESS_UNIT' AND business_unit_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_role_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    assigned_by_user_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES access_roles(role_id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(user_id, role_id, effective_from)
);

CREATE TABLE IF NOT EXISTS user_role_scopes (
    scope_id TEXT PRIMARY KEY,
    user_role_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('OWN','TEAM','BUSINESS_UNIT','AFFILIATE','COUNTRY','GROUP')),
    country_id TEXT,
    affiliate_id TEXT,
    business_unit_id TEXT,
    team_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_role_id) REFERENCES user_roles(user_role_id) ON DELETE CASCADE,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE CASCADE,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE CASCADE,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
    CHECK(
        scope_type='OWN'
        OR scope_type='GROUP'
        OR (scope_type='TEAM' AND team_id IS NOT NULL)
        OR (scope_type='BUSINESS_UNIT' AND business_unit_id IS NOT NULL)
        OR (scope_type='AFFILIATE' AND affiliate_id IS NOT NULL)
        OR (scope_type='COUNTRY' AND country_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS customer_portal_memberships (
    portal_membership_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    contact_id TEXT,
    portal_role_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('INVITED','ACTIVE','SUSPENDED','REVOKED')),
    invited_at TEXT,
    invited_by_user_id TEXT,
    activated_at TEXT,
    last_access_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (portal_role_id) REFERENCES access_roles(role_id) ON DELETE RESTRICT,
    FOREIGN KEY (invited_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(user_id, account_id)
);

CREATE TABLE IF NOT EXISTS source_systems (
    source_system_id TEXT PRIMARY KEY,
    system_name TEXT NOT NULL UNIQUE,
    system_type TEXT NOT NULL CHECK(system_type IN ('ORACLE','EXCEL','WEB_FORM','EMAIL','MANUAL','API','OTHER')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_identities (
    source_identity_id TEXT PRIMARY KEY,
    source_system_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    external_username TEXT NOT NULL COLLATE NOCASE,
    affiliate_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_system_id) REFERENCES source_systems(source_system_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    UNIQUE(source_system_id, external_username)
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    verification_token_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('PENDING','USED','EXPIRED','REVOKED')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CHECK(expires_at >= issued_at)
);

CREATE TABLE IF NOT EXISTS product_groups (
    product_group_id TEXT PRIMARY KEY,
    group_code TEXT NOT NULL UNIQUE,
    group_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS product_categories (
    product_category_id TEXT PRIMARY KEY,
    product_group_id TEXT NOT NULL,
    parent_category_id TEXT,
    category_code TEXT NOT NULL UNIQUE,
    category_name TEXT NOT NULL,
    default_uom TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 100,
    FOREIGN KEY (product_group_id) REFERENCES product_groups(product_group_id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_category_id) REFERENCES product_categories(product_category_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS products (
    product_id TEXT PRIMARY KEY,
    product_code TEXT NOT NULL UNIQUE,
    product_name TEXT NOT NULL,
    product_category_id TEXT NOT NULL,
    unit_of_measure TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_category_id) REFERENCES product_categories(product_category_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS workflow_roles (
    workflow_role_id TEXT PRIMARY KEY,
    role_code TEXT NOT NULL UNIQUE,
    role_name TEXT NOT NULL UNIQUE,
    process_type TEXT CHECK(process_type IS NULL OR process_type IN ('LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','CREDIT_EXCEPTION','OTHER')),
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_role_assignments (
    workflow_role_assignment_id TEXT PRIMARY KEY,
    workflow_role_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('BUSINESS_UNIT','AFFILIATE','COUNTRY','GROUP')),
    country_id TEXT,
    affiliate_id TEXT,
    business_unit_id TEXT,
    priority INTEGER NOT NULL DEFAULT 100 CHECK(priority >= 0),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_role_id) REFERENCES workflow_roles(workflow_role_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE CASCADE,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE CASCADE,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE CASCADE,
    CHECK(effective_to IS NULL OR effective_to >= effective_from),
    CHECK(
        (scope_type='GROUP' AND country_id IS NULL AND affiliate_id IS NULL AND business_unit_id IS NULL)
        OR (scope_type='COUNTRY' AND country_id IS NOT NULL)
        OR (scope_type='AFFILIATE' AND affiliate_id IS NOT NULL)
        OR (scope_type='BUSINESS_UNIT' AND business_unit_id IS NOT NULL)
    ),
    UNIQUE(workflow_role_id, user_id, scope_type, country_id, affiliate_id, business_unit_id, effective_from)
);

CREATE TABLE IF NOT EXISTS approval_authority_rules (
    authority_rule_id TEXT PRIMARY KEY,
    workflow_role_assignment_id TEXT NOT NULL,
    process_type TEXT NOT NULL CHECK(process_type IN ('SALES_ORDER','PURCHASE_ORDER','CREDIT_EXCEPTION','OTHER')),
    currency_code TEXT,
    min_amount REAL CHECK(min_amount IS NULL OR min_amount >= 0),
    max_amount REAL CHECK(max_amount IS NULL OR max_amount >= 0),
    product_group_id TEXT,
    product_category_id TEXT,
    rule_priority INTEGER NOT NULL DEFAULT 100 CHECK(rule_priority >= 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    FOREIGN KEY (workflow_role_assignment_id) REFERENCES workflow_role_assignments(workflow_role_assignment_id) ON DELETE CASCADE,
    FOREIGN KEY (product_group_id) REFERENCES product_groups(product_group_id) ON DELETE SET NULL,
    FOREIGN KEY (product_category_id) REFERENCES product_categories(product_category_id) ON DELETE SET NULL,
    CHECK(max_amount IS NULL OR min_amount IS NULL OR max_amount >= min_amount),
    CHECK(effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_definition_id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    process_type TEXT NOT NULL CHECK(process_type IN ('LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','CREDIT_EXCEPTION','OTHER')),
    country_id TEXT,
    affiliate_id TEXT,
    business_unit_id TEXT,
    version_no INTEGER NOT NULL CHECK(version_no > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE SET NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    UNIQUE(workflow_name, version_no)
);

CREATE TABLE IF NOT EXISTS workflow_stages (
    workflow_stage_id TEXT PRIMARY KEY,
    workflow_definition_id TEXT NOT NULL,
    stage_code TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
    assignment_type TEXT NOT NULL CHECK(assignment_type IN ('USER','WORKFLOW_ROLE','TEAM','SYSTEM')),
    assigned_user_id TEXT,
    assigned_workflow_role_id TEXT,
    assigned_team_id TEXT,
    approval_mode TEXT NOT NULL DEFAULT 'ANY_ONE' CHECK(approval_mode IN ('ANY_ONE','ALL','SEQUENTIAL','ROUND_ROBIN','NAMED','SYSTEM')),
    required_approvals INTEGER NOT NULL DEFAULT 1 CHECK(required_approvals >= 0),
    sla_rule_id TEXT,
    terminal_stage INTEGER NOT NULL DEFAULT 0 CHECK(terminal_stage IN (0,1)),
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(workflow_definition_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_workflow_role_id) REFERENCES workflow_roles(workflow_role_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (sla_rule_id) REFERENCES sla_rules(sla_rule_id) ON DELETE SET NULL,
    UNIQUE(workflow_definition_id, sequence_no),
    UNIQUE(workflow_definition_id, stage_code)
);

CREATE TABLE IF NOT EXISTS workflow_instances (
    workflow_instance_id TEXT PRIMARY KEY,
    workflow_definition_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED','CANCELLED')),
    started_at TEXT,
    completed_at TEXT,
    current_stage_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(workflow_definition_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_stage_id) REFERENCES workflow_stages(workflow_stage_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_stage_instances (
    workflow_stage_instance_id TEXT PRIMARY KEY,
    workflow_instance_id TEXT NOT NULL,
    workflow_stage_id TEXT NOT NULL,
    assigned_user_id TEXT,
    assigned_team_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','APPROVED','REJECTED','SKIPPED','COMPLETED')),
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    action_notes TEXT,
    FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances(workflow_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_stage_id) REFERENCES workflow_stages(workflow_stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_team_id) REFERENCES teams(team_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_stage_assignees (
    workflow_stage_assignee_id TEXT PRIMARY KEY,
    workflow_stage_instance_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workflow_role_assignment_id TEXT,
    sequence_no INTEGER NOT NULL DEFAULT 1 CHECK(sequence_no > 0),
    required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
    status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','APPROVED','REJECTED','SKIPPED','COMPLETED')),
    assigned_at TEXT NOT NULL,
    acted_at TEXT,
    decision TEXT,
    notes TEXT,
    FOREIGN KEY (workflow_stage_instance_id) REFERENCES workflow_stage_instances(workflow_stage_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (workflow_role_assignment_id) REFERENCES workflow_role_assignments(workflow_role_assignment_id) ON DELETE SET NULL,
    UNIQUE(workflow_stage_instance_id, user_id)
);

CREATE TABLE IF NOT EXISTS sla_rules (
    sla_rule_id TEXT PRIMARY KEY,
    sla_profile_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','WORKFLOW_STAGE')),
    stage_code TEXT,
    priority TEXT,
    target_minutes INTEGER NOT NULL CHECK(target_minutes > 0),
    warning_minutes INTEGER CHECK(warning_minutes IS NULL OR warning_minutes >= 0),
    business_calendar_id TEXT NOT NULL,
    business_hours_only INTEGER NOT NULL DEFAULT 1 CHECK(business_hours_only IN (0,1)),
    pause_allowed INTEGER NOT NULL DEFAULT 1 CHECK(pause_allowed IN (0,1)),
    escalation_after_minutes INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    FOREIGN KEY (sla_profile_id) REFERENCES sla_profiles(sla_profile_id) ON DELETE CASCADE,
    FOREIGN KEY (business_calendar_id) REFERENCES business_calendars(business_calendar_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_calendars (
    business_calendar_id TEXT PRIMARY KEY,
    calendar_name TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL,
    workday_start TEXT NOT NULL,
    workday_end TEXT NOT NULL,
    monday INTEGER NOT NULL DEFAULT 1 CHECK(monday IN (0,1)),
    tuesday INTEGER NOT NULL DEFAULT 1 CHECK(tuesday IN (0,1)),
    wednesday INTEGER NOT NULL DEFAULT 1 CHECK(wednesday IN (0,1)),
    thursday INTEGER NOT NULL DEFAULT 1 CHECK(thursday IN (0,1)),
    friday INTEGER NOT NULL DEFAULT 1 CHECK(friday IN (0,1)),
    saturday INTEGER NOT NULL DEFAULT 0 CHECK(saturday IN (0,1)),
    sunday INTEGER NOT NULL DEFAULT 0 CHECK(sunday IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE IF NOT EXISTS sla_profiles (
    sla_profile_id TEXT PRIMARY KEY,
    profile_name TEXT NOT NULL UNIQUE,
    sla_type TEXT NOT NULL CHECK(sla_type IN ('INTERNAL','EXTERNAL')),
    precedence_level INTEGER NOT NULL CHECK(precedence_level BETWEEN 1 AND 100),
    account_id TEXT,
    segment TEXT,
    affiliate_id TEXT,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mfa_methods (
    mfa_method_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    method_type TEXT NOT NULL CHECK(method_type IN ('TOTP','EMAIL_OTP','WEBAUTHN')),
    label TEXT,
    secret_encrypted TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE(user_id, method_type, label)
);

-- ============================================================================
-- The CRM, service, SLA runtime, order and ingestion tables.
--
-- Copied verbatim from the operator's hass_cms_turso_v1_FINAL.sql, which holds
-- 72 tables. The 39 above arrived with Build Prompts 03 to 09; these 33 are the
-- remainder, added for the 10-to-19 batch so a test proves the code satisfies
-- the real constraints rather than a relaxed copy of them.
--
-- THE SOURCE-COMPLETENESS SCRIPT IS ALSO MIRRORED, as of Build Prompt 17:
-- purchase_orders.submitted_for_approval_at exists, and the commercial
-- columns on the four order tables (currency, value, supplier, quantity,
-- price) accept NULL, exactly as the batch instructions describe the
-- operator's script leaving the live database. The importer verifies the
-- same facts with pragma queries before any import starts and refuses
-- loudly where they do not hold, because NULL versus zero is the point of
-- that script: the real extracts carry no commercial values at all.
--
-- sla_breaches and sla_escalation_events below MIRROR THE OPERATOR'S SLA
-- RUNTIME SCRIPT, which Build Prompt 15's instructions state has been run
-- against the live database (the batch document describes testing against
-- the real tables). Their shapes come from those instructions: one primary
-- breach row per instance enforced by UNIQUE(sla_instance_id), one
-- escalation per level enforced by UNIQUE(sla_instance_id, escalation_level),
-- and four indexes. Neither is a migration in the product: the operator runs
-- the scripts by hand, and the runtime verifies both tables exist before the
-- engine starts rather than assuming.
-- ============================================================================



CREATE TABLE IF NOT EXISTS password_reset_tokens (
    reset_token_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('PENDING','USED','EXPIRED','REVOKED')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CHECK(expires_at >= issued_at)
);

CREATE TABLE IF NOT EXISTS lead_sources (
    lead_source_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id TEXT PRIMARY KEY,
    campaign_name TEXT NOT NULL,
    campaign_type TEXT NOT NULL CHECK(campaign_type IN ('DIRECT','DIGITAL','EVENT','REFERRAL','RETENTION','OTHER')),
    start_date TEXT,
    end_date TEXT,
    target_revenue REAL CHECK(target_revenue IS NULL OR target_revenue >= 0),
    owner_team_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_team_id) REFERENCES teams(team_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
    pipeline_id TEXT PRIMARY KEY,
    pipeline_name TEXT NOT NULL UNIQUE,
    country_id TEXT,
    affiliate_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE SET NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
    pipeline_stage_id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
    default_probability REAL NOT NULL DEFAULT 0 CHECK(default_probability BETWEEN 0 AND 1),
    target_days INTEGER CHECK(target_days IS NULL OR target_days >= 0),
    is_won_stage INTEGER NOT NULL DEFAULT 0 CHECK(is_won_stage IN (0,1)),
    is_lost_stage INTEGER NOT NULL DEFAULT 0 CHECK(is_lost_stage IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id) ON DELETE CASCADE,
    UNIQUE(pipeline_id, sequence_no),
    UNIQUE(pipeline_id, stage_name)
);

CREATE TABLE IF NOT EXISTS leads (
    lead_id TEXT PRIMARY KEY,
    lead_number TEXT NOT NULL UNIQUE,
    account_id TEXT,
    primary_contact_id TEXT,
    lead_source_id TEXT NOT NULL,
    campaign_id TEXT,
    business_unit_id TEXT,
    owner_user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    product_interest TEXT,
    estimated_volume REAL CHECK(estimated_volume IS NULL OR estimated_volume >= 0),
    estimated_value REAL CHECK(estimated_value IS NULL OR estimated_value >= 0),
    currency_code TEXT,
    captured_at TEXT NOT NULL,
    first_contact_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('NEW','CONTACTED','QUALIFIED','DISQUALIFIED','CONVERTED')),
    disqualification_reason TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
    FOREIGN KEY (primary_contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (lead_source_id) REFERENCES lead_sources(lead_source_id) ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE SET NULL,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS lead_qualifications (
    qualification_id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    budget_score INTEGER NOT NULL CHECK(budget_score BETWEEN 0 AND 5),
    authority_score INTEGER NOT NULL CHECK(authority_score BETWEEN 0 AND 5),
    need_score INTEGER NOT NULL CHECK(need_score BETWEEN 0 AND 5),
    timeline_score INTEGER NOT NULL CHECK(timeline_score BETWEEN 0 AND 5),
    qualification_notes TEXT,
    qualified_by_user_id TEXT NOT NULL,
    qualified_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE,
    FOREIGN KEY (qualified_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS lost_reasons (
    lost_reason_id TEXT PRIMARY KEY,
    reason_name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE IF NOT EXISTS opportunities (
    opportunity_id TEXT PRIMARY KEY,
    opportunity_number TEXT NOT NULL UNIQUE,
    lead_id TEXT,
    account_id TEXT NOT NULL,
    business_unit_id TEXT,
    pipeline_id TEXT NOT NULL,
    current_stage_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    estimated_value REAL NOT NULL CHECK(estimated_value >= 0),
    currency_code TEXT NOT NULL,
    probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
    estimated_close_date TEXT,
    actual_close_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('OPEN','WON','LOST')),
    won_amount REAL CHECK(won_amount IS NULL OR won_amount >= 0),
    lost_reason_id TEXT,
    lost_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE RESTRICT,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(pipeline_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_stage_id) REFERENCES pipeline_stages(pipeline_stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (lost_reason_id) REFERENCES lost_reasons(lost_reason_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunity_products (
    opportunity_product_id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    expected_quantity REAL NOT NULL CHECK(expected_quantity >= 0),
    unit_price REAL CHECK(unit_price IS NULL OR unit_price >= 0),
    estimated_line_value REAL CHECK(estimated_line_value IS NULL OR estimated_line_value >= 0),
    FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS opportunity_stage_history (
    stage_history_id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    from_stage_id TEXT,
    to_stage_id TEXT NOT NULL,
    changed_by_user_id TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    duration_in_previous_stage_minutes INTEGER CHECK(duration_in_previous_stage_minutes IS NULL OR duration_in_previous_stage_minutes >= 0),
    reason TEXT,
    FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
    FOREIGN KEY (from_stage_id) REFERENCES pipeline_stages(pipeline_stage_id) ON DELETE SET NULL,
    FOREIGN KEY (to_stage_id) REFERENCES pipeline_stages(pipeline_stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS activities (
    activity_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('ACCOUNT','LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','CAMPAIGN')),
    entity_id TEXT NOT NULL,
    account_id TEXT,
    contact_id TEXT,
    activity_type TEXT NOT NULL CHECK(activity_type IN ('CALL','EMAIL','WHATSAPP','MEETING','VISIT','QUOTATION','PROPOSAL','FOLLOW_UP','NOTE','TASK','OTHER')),
    owner_user_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    notes TEXT,
    scheduled_at TEXT,
    completed_at TEXT,
    outcome TEXT,
    next_action TEXT,
    next_action_due TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS case_categories (
    case_category_id TEXT PRIMARY KEY,
    category_name TEXT NOT NULL,
    subcategory_name TEXT NOT NULL,
    default_priority TEXT NOT NULL CHECK(default_priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    UNIQUE(category_name, subcategory_name)
);

CREATE TABLE IF NOT EXISTS service_cases (
    case_id TEXT PRIMARY KEY,
    case_number TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    contact_id TEXT,
    business_unit_id TEXT,
    case_type TEXT NOT NULL CHECK(case_type IN ('ENQUIRY','COMPLAINT','REQUEST','INCIDENT','FEEDBACK','COMPLIMENT')),
    case_category_id TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('EMAIL','PHONE','WHATSAPP','WEB','WALK_IN','SOCIAL','OTHER')),
    status TEXT NOT NULL CHECK(status IN ('NEW','ASSIGNED','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','RESOLVED','CLOSED','CANCELLED')),
    assigned_team_id TEXT,
    assigned_user_id TEXT,
    raised_at TEXT NOT NULL,
    first_response_at TEXT,
    resolved_at TEXT,
    closed_at TEXT,
    root_cause TEXT,
    resolution_summary TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE RESTRICT,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    FOREIGN KEY (case_category_id) REFERENCES case_categories(case_category_id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS case_assignment_history (
    case_assignment_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    from_team_id TEXT,
    from_user_id TEXT,
    to_team_id TEXT,
    to_user_id TEXT,
    assigned_by_user_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    reason TEXT,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE CASCADE,
    FOREIGN KEY (from_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (to_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (to_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS case_status_history (
    case_status_history_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_by_user_id TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    reason TEXT,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS case_communications (
    communication_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND','INTERNAL')),
    channel TEXT NOT NULL CHECK(channel IN ('EMAIL','PHONE','WHATSAPP','WEB','NOTE','OTHER')),
    contact_id TEXT,
    user_id TEXT,
    subject TEXT,
    message_summary TEXT NOT NULL,
    communicated_at TEXT NOT NULL,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customer_surveys (
    survey_id TEXT PRIMARY KEY,
    survey_name TEXT NOT NULL,
    survey_type TEXT NOT NULL CHECK(survey_type IN ('CSAT','NPS','CES','OTHER')),
    question_text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE IF NOT EXISTS survey_responses (
    survey_response_id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL,
    case_id TEXT,
    account_id TEXT NOT NULL,
    contact_id TEXT,
    score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 10),
    comments TEXT,
    responded_at TEXT NOT NULL,
    FOREIGN KEY (survey_id) REFERENCES customer_surveys(survey_id) ON DELETE RESTRICT,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE RESTRICT,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS holidays (
    holiday_id TEXT PRIMARY KEY,
    business_calendar_id TEXT NOT NULL,
    holiday_date TEXT NOT NULL,
    holiday_name TEXT NOT NULL,
    FOREIGN KEY (business_calendar_id) REFERENCES business_calendars(business_calendar_id) ON DELETE CASCADE,
    UNIQUE(business_calendar_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS sla_instances (
    sla_instance_id TEXT PRIMARY KEY,
    sla_rule_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    workflow_stage_instance_id TEXT,
    accountable_user_id TEXT,
    accountable_team_id TEXT,
    started_at TEXT NOT NULL,
    target_at TEXT NOT NULL,
    warning_at TEXT,
    stopped_at TEXT,
    paused_minutes INTEGER NOT NULL DEFAULT 0 CHECK(paused_minutes >= 0),
    status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSED','MET','BREACHED','CANCELLED')),
    breached_at TEXT,
    FOREIGN KEY (sla_rule_id) REFERENCES sla_rules(sla_rule_id) ON DELETE RESTRICT,
    FOREIGN KEY (workflow_stage_instance_id) REFERENCES workflow_stage_instances(workflow_stage_instance_id) ON DELETE SET NULL,
    FOREIGN KEY (accountable_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (accountable_team_id) REFERENCES teams(team_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sla_timer_events (
    sla_timer_event_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('START','PAUSE','RESUME','WARNING','BREACH','STOP','CANCEL')),
    event_at TEXT NOT NULL,
    reason TEXT,
    actor_user_id TEXT,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sales_orders (
    sales_order_id TEXT PRIMARY KEY,
    document_number TEXT NOT NULL,
    affiliate_id TEXT NOT NULL,
    business_unit_id TEXT,
    account_id TEXT NOT NULL,
    order_created_at TEXT NOT NULL,
    currency_code TEXT,
    order_value REAL CHECK(order_value IS NULL OR order_value >= 0),
    finance_approval_required INTEGER NOT NULL DEFAULT 1 CHECK(finance_approval_required IN (0,1)),
    credit_approval_required INTEGER NOT NULL DEFAULT 0 CHECK(credit_approval_required IN (0,1)),
    credit_exception_reason TEXT,
    invoice_number TEXT,
    invoice_created_at TEXT,
    loading_authority_at TEXT,
    loaded_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('CREATED','PENDING_FINANCE','PENDING_CREDIT','READY','INVOICED','LOADING','LOADED','CANCELLED')),
    latest_snapshot_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE RESTRICT,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE RESTRICT,
    UNIQUE(affiliate_id, document_number)
);

CREATE TABLE IF NOT EXISTS sales_order_lines (
    sales_order_line_id TEXT PRIMARY KEY,
    sales_order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK(line_number > 0),
    product_id TEXT NOT NULL,
    quantity REAL CHECK(quantity IS NULL OR quantity >= 0),
    unit_price REAL CHECK(unit_price IS NULL OR unit_price >= 0),
    line_value REAL CHECK(line_value IS NULL OR line_value >= 0),
    FOREIGN KEY (sales_order_id) REFERENCES sales_orders(sales_order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    UNIQUE(sales_order_id, line_number)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    purchase_order_id TEXT PRIMARY KEY,
    document_number TEXT NOT NULL,
    affiliate_id TEXT NOT NULL,
    business_unit_id TEXT,
    supplier_name TEXT,
    po_created_at TEXT NOT NULL,
    submitted_for_approval_at TEXT,
    currency_code TEXT,
    po_value REAL CHECK(po_value IS NULL OR po_value >= 0),
    physical_received_at TEXT,
    oracle_stock_posted_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('CREATED','IN_APPROVAL','APPROVED','RECEIVED','POSTED','CANCELLED')),
    latest_snapshot_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE RESTRICT,
    FOREIGN KEY (business_unit_id) REFERENCES business_units(business_unit_id) ON DELETE SET NULL,
    UNIQUE(affiliate_id, document_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    purchase_order_line_id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK(line_number > 0),
    product_id TEXT NOT NULL,
    quantity REAL CHECK(quantity IS NULL OR quantity >= 0),
    unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
    line_value REAL CHECK(line_value IS NULL OR line_value >= 0),
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(purchase_order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    UNIQUE(purchase_order_id, line_number)
);

CREATE TABLE IF NOT EXISTS import_batches (
    import_batch_id TEXT PRIMARY KEY,
    source_system_id TEXT NOT NULL,
    import_type TEXT NOT NULL CHECK(import_type IN ('SALES_ORDER','PURCHASE_ORDER','LEAD','CONTACT','CASE','OTHER')),
    original_filename TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    uploaded_by_user_id TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    reporting_period_from TEXT,
    reporting_period_to TEXT,
    rows_received INTEGER NOT NULL DEFAULT 0 CHECK(rows_received >= 0),
    rows_new INTEGER NOT NULL DEFAULT 0 CHECK(rows_new >= 0),
    rows_changed INTEGER NOT NULL DEFAULT 0 CHECK(rows_changed >= 0),
    rows_exact_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(rows_exact_duplicate >= 0),
    rows_rejected INTEGER NOT NULL DEFAULT 0 CHECK(rows_rejected >= 0),
    status TEXT NOT NULL CHECK(status IN ('VALIDATING','READY','IMPORTED','PARTIAL','REJECTED')),
    FOREIGN KEY (source_system_id) REFERENCES source_systems(source_system_id) ON DELETE RESTRICT,
    FOREIGN KEY (uploaded_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    UNIQUE(file_sha256)
);

CREATE TABLE IF NOT EXISTS import_rows (
    import_row_id TEXT PRIMARY KEY,
    import_batch_id TEXT NOT NULL,
    source_row_number INTEGER NOT NULL CHECK(source_row_number > 0),
    source_record_key TEXT,
    entity_type TEXT,
    entity_id TEXT,
    row_hash TEXT NOT NULL,
    row_status TEXT NOT NULL CHECK(row_status IN ('NEW','CHANGED','DUPLICATE','REJECTED','UNRESOLVED')),
    error_message TEXT,
    raw_json TEXT NOT NULL,
    imported_at TEXT,
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id) ON DELETE CASCADE,
    UNIQUE(import_batch_id, source_row_number)
);

CREATE TABLE IF NOT EXISTS record_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('SALES_ORDER','PURCHASE_ORDER','LEAD','CASE','CONTACT','ACCOUNT')),
    entity_id TEXT NOT NULL,
    import_batch_id TEXT,
    source_record_key TEXT,
    version_no INTEGER NOT NULL CHECK(version_no > 0),
    row_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id) ON DELETE SET NULL,
    UNIQUE(entity_type, entity_id, version_no)
);

CREATE TABLE IF NOT EXISTS unresolved_actors (
    unresolved_actor_id TEXT PRIMARY KEY,
    import_batch_id TEXT NOT NULL,
    source_system_id TEXT NOT NULL,
    external_username TEXT NOT NULL,
    affiliate_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('OPEN','MAPPED','IGNORED')),
    mapped_user_id TEXT,
    resolved_by_user_id TEXT,
    resolved_at TEXT,
    notes TEXT,
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id) ON DELETE CASCADE,
    FOREIGN KEY (source_system_id) REFERENCES source_systems(source_system_id) ON DELETE RESTRICT,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (mapped_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (resolved_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS file_objects (
    file_id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT,
    size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
    sha256 TEXT,
    uploaded_by_user_id TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY (uploaded_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS entity_attachments (
    entity_attachment_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('ACCOUNT','CONTACT','LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','ACTIVITY')),
    entity_id TEXT NOT NULL,
    attachment_type TEXT,
    attached_by_user_id TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    FOREIGN KEY (file_id) REFERENCES file_objects(file_id) ON DELETE CASCADE,
    FOREIGN KEY (attached_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS notifications (
    notification_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    notification_type TEXT NOT NULL CHECK(notification_type IN ('ASSIGNMENT','SLA_WARNING','SLA_BREACH','FOLLOW_UP','IMPORT_EXCEPTION','SYSTEM')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_leads_owner_status ON leads(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner_status ON opportunities(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_cases_assignee_status ON service_cases(assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_account ON service_cases(account_id, raised_at);
CREATE INDEX IF NOT EXISTS idx_so_account_date ON sales_orders(account_id, order_created_at);
CREATE INDEX IF NOT EXISTS idx_po_affiliate_date ON purchase_orders(affiliate_id, po_created_at);
CREATE INDEX IF NOT EXISTS idx_sla_entity ON sla_instances(entity_type, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(import_batch_id, row_status);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON record_snapshots(entity_type, entity_id, version_no);

-- The operator's SLA runtime script, mirrored. See the note above.
CREATE TABLE IF NOT EXISTS sla_breaches (
    sla_breach_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    breached_at TEXT NOT NULL,
    target_at TEXT NOT NULL,
    breach_minutes INTEGER CHECK(breach_minutes IS NULL OR breach_minutes >= 0),
    accountable_user_id TEXT,
    accountable_team_id TEXT,
    workflow_stage_instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (accountable_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (accountable_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    UNIQUE(sla_instance_id)
);

CREATE TABLE IF NOT EXISTS sla_escalation_events (
    sla_escalation_event_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL,
    escalation_level INTEGER NOT NULL CHECK(escalation_level > 0),
    escalated_at TEXT NOT NULL,
    recipient_user_id TEXT,
    notification_id TEXT,
    details_json TEXT,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(sla_instance_id, escalation_level)
);

CREATE INDEX IF NOT EXISTS idx_sla_instances_due ON sla_instances(status, target_at);
CREATE INDEX IF NOT EXISTS idx_sla_instances_entity ON sla_instances(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sla_breaches_accountable ON sla_breaches(accountable_user_id, accountable_team_id);
CREATE INDEX IF NOT EXISTS idx_sla_escalations_instance ON sla_escalation_events(sla_instance_id);

`;
