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
`;
