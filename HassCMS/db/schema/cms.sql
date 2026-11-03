-- Reviewed CMS target schema: operator export 2026-11-02 plus repairs 003/004
-- and duplicate-index cleanup 005. SCHEMA ONLY: no production/demo data.
-- Reference for tests and compatibility checks, NOT a live rollout script.
-- Review incremental migrations separately; never apply this baseline over live tables.

CREATE TABLE countries (
    country_id TEXT PRIMARY KEY,
    iso2 TEXT NOT NULL UNIQUE CHECK(length(iso2)=2),
    country_name TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE affiliates (
    affiliate_id TEXT PRIMARY KEY,
    affiliate_code TEXT NOT NULL UNIQUE,
    affiliate_name TEXT NOT NULL,
    country_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, extract_code TEXT,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE RESTRICT
);

CREATE TABLE business_units (
    business_unit_id TEXT PRIMARY KEY,
    business_unit_code TEXT NOT NULL UNIQUE,
    business_unit_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE departments (
    department_id TEXT PRIMARY KEY,
    department_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE job_titles (
    job_title_id TEXT PRIMARY KEY,
    title_name TEXT NOT NULL UNIQUE,
    department_id TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE SET NULL
);

CREATE TABLE teams (
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

CREATE TABLE users (
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

CREATE TABLE auth_credentials (
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

CREATE TABLE auth_sessions (
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

CREATE TABLE email_verification_tokens (
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

CREATE TABLE password_reset_tokens (
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

CREATE TABLE login_attempts (
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

CREATE TABLE mfa_methods (
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

CREATE TABLE user_assignments (
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

CREATE TABLE team_members (
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

CREATE TABLE access_roles (
    role_id TEXT PRIMARY KEY,
    role_name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_system_role INTEGER NOT NULL DEFAULT 0 CHECK(is_system_role IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE permissions (
    permission_id TEXT PRIMARY KEY,
    module_name TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    action_name TEXT NOT NULL,
    description TEXT,
    UNIQUE(module_name, resource_name, action_name)
);

CREATE TABLE role_permissions (
    role_permission_id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1 CHECK(allowed IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES access_roles(role_id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE CASCADE,
    UNIQUE(role_id, permission_id)
);

CREATE TABLE user_roles (
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

CREATE TABLE user_role_scopes (
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

CREATE TABLE workflow_roles (
    workflow_role_id TEXT PRIMARY KEY,
    role_code TEXT NOT NULL UNIQUE,
    role_name TEXT NOT NULL UNIQUE,
    process_type TEXT CHECK(process_type IS NULL OR process_type IN ('LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','CREDIT_EXCEPTION','OTHER')),
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_role_assignments (
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

CREATE TABLE approval_authority_rules (
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

CREATE TABLE source_systems (
    source_system_id TEXT PRIMARY KEY,
    system_name TEXT NOT NULL UNIQUE,
    system_type TEXT NOT NULL CHECK(system_type IN ('ORACLE','EXCEL','WEB_FORM','EMAIL','MANUAL','API','OTHER')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_identities (
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

CREATE TABLE product_groups (
    product_group_id TEXT PRIMARY KEY,
    group_code TEXT NOT NULL UNIQUE,
    group_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE product_categories (
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

CREATE TABLE products (
    product_id TEXT PRIMARY KEY,
    product_code TEXT NOT NULL UNIQUE,
    product_name TEXT NOT NULL,
    product_category_id TEXT NOT NULL,
    unit_of_measure TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_category_id) REFERENCES product_categories(product_category_id) ON DELETE RESTRICT
);

CREATE TABLE accounts (
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

CREATE TABLE contacts (
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, portal_role TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE customer_portal_memberships (
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

CREATE TABLE lead_sources (
    lead_source_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE campaigns (
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

CREATE TABLE pipelines (
    pipeline_id TEXT PRIMARY KEY,
    pipeline_name TEXT NOT NULL UNIQUE,
    country_id TEXT,
    affiliate_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (country_id) REFERENCES countries(country_id) ON DELETE SET NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL
);

CREATE TABLE pipeline_stages (
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

CREATE TABLE leads (
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

CREATE TABLE lead_qualifications (
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

CREATE TABLE lost_reasons (
    lost_reason_id TEXT PRIMARY KEY,
    reason_name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE opportunities (
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

CREATE TABLE opportunity_products (
    opportunity_product_id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    expected_quantity REAL NOT NULL CHECK(expected_quantity >= 0),
    unit_price REAL CHECK(unit_price IS NULL OR unit_price >= 0),
    estimated_line_value REAL CHECK(estimated_line_value IS NULL OR estimated_line_value >= 0),
    FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT
);

CREATE TABLE opportunity_stage_history (
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

CREATE TABLE activities (
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

CREATE TABLE case_categories (
    case_category_id TEXT PRIMARY KEY,
    category_name TEXT NOT NULL,
    subcategory_name TEXT NOT NULL,
    default_priority TEXT NOT NULL CHECK(default_priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    UNIQUE(category_name, subcategory_name)
);

CREATE TABLE service_cases (
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

CREATE TABLE case_assignment_history (
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

CREATE TABLE case_status_history (
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

CREATE TABLE case_communications (
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

CREATE TABLE customer_surveys (
    survey_id TEXT PRIMARY KEY,
    survey_name TEXT NOT NULL,
    survey_type TEXT NOT NULL CHECK(survey_type IN ('CSAT','NPS','CES','OTHER')),
    question_text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE survey_responses (
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

CREATE TABLE business_calendars (
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

CREATE TABLE holidays (
    holiday_id TEXT PRIMARY KEY,
    business_calendar_id TEXT NOT NULL,
    holiday_date TEXT NOT NULL,
    holiday_name TEXT NOT NULL,
    FOREIGN KEY (business_calendar_id) REFERENCES business_calendars(business_calendar_id) ON DELETE CASCADE,
    UNIQUE(business_calendar_id, holiday_date)
);

CREATE TABLE sla_profiles (
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

CREATE TABLE sla_rules (
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

CREATE TABLE workflow_definitions (
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

CREATE TABLE workflow_stages (
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

CREATE TABLE workflow_instances (
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

CREATE TABLE workflow_stage_instances (
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

CREATE TABLE workflow_stage_assignees (
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

CREATE TABLE sla_instances (
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

CREATE TABLE sla_timer_events (
    sla_timer_event_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('START','PAUSE','RESUME','WARNING','BREACH','STOP','CANCEL')),
    event_at TEXT NOT NULL,
    reason TEXT,
    actor_user_id TEXT,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE import_batches (
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

CREATE TABLE import_rows (
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

CREATE TABLE record_snapshots (
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

CREATE TABLE unresolved_actors (
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

CREATE TABLE file_objects (
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

CREATE TABLE entity_attachments (
    entity_attachment_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('ACCOUNT','CONTACT','LEAD','OPPORTUNITY','CASE','SALES_ORDER','PURCHASE_ORDER','ACTIVITY')),
    entity_id TEXT NOT NULL,
    attachment_type TEXT,
    attached_by_user_id TEXT NOT NULL,
    attached_at TEXT NOT NULL, customer_visible INTEGER NOT NULL DEFAULT 0
  CHECK(customer_visible IN (0,1)), portal_document_title TEXT,
    FOREIGN KEY (file_id) REFERENCES file_objects(file_id) ON DELETE CASCADE,
    FOREIGN KEY (attached_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE notifications (
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

CREATE TABLE audit_events (
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

CREATE TABLE sla_breaches (
    sla_breach_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL UNIQUE,
    breached_at TEXT NOT NULL,
    breach_minutes INTEGER CHECK(breach_minutes IS NULL OR breach_minutes >= 0),
    accountable_user_id TEXT,
    accountable_team_id TEXT,
    workflow_stage_instance_id TEXT,
    resolved_at TEXT,
    resolution_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (accountable_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (accountable_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (workflow_stage_instance_id) REFERENCES workflow_stage_instances(workflow_stage_instance_id) ON DELETE SET NULL,
    CHECK(resolved_at IS NULL OR resolved_at >= breached_at)
);

CREATE TABLE sla_escalation_events (
    sla_escalation_event_id TEXT PRIMARY KEY,
    sla_instance_id TEXT NOT NULL,
    escalation_level INTEGER NOT NULL CHECK(escalation_level > 0),
    triggered_at TEXT NOT NULL,
    recipient_user_id TEXT,
    recipient_team_id TEXT,
    notification_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','FAILED','ACKNOWLEDGED','CANCELLED')),
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sla_instance_id) REFERENCES sla_instances(sla_instance_id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (recipient_team_id) REFERENCES teams(team_id) ON DELETE SET NULL,
    FOREIGN KEY (notification_id) REFERENCES notifications(notification_id) ON DELETE SET NULL,
    UNIQUE(sla_instance_id, escalation_level)
);

CREATE TABLE "sales_orders" (
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

CREATE TABLE "sales_order_lines" (
    sales_order_line_id TEXT PRIMARY KEY,
    sales_order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK(line_number > 0),
    product_id TEXT NOT NULL,
    quantity REAL CHECK(quantity IS NULL OR quantity >= 0),
    unit_price REAL CHECK(unit_price IS NULL OR unit_price >= 0),
    line_value REAL CHECK(line_value IS NULL OR line_value >= 0),
    FOREIGN KEY (sales_order_id) REFERENCES "sales_orders"(sales_order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    UNIQUE(sales_order_id, line_number)
);

CREATE TABLE survey_invitations (
    survey_invitation_id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL,
    case_id TEXT,
    account_id TEXT NOT NULL,
    contact_id TEXT,
    token_hash TEXT UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','RESPONDED','EXPIRED','CANCELLED')),
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    responded_at TEXT,
    survey_response_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_id) REFERENCES customer_surveys(survey_id) ON DELETE RESTRICT,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE RESTRICT,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(survey_response_id) ON DELETE SET NULL,
    UNIQUE(survey_id, case_id, contact_id),
    CHECK(expires_at IS NULL OR expires_at >= issued_at)
);

CREATE TABLE so_extract_rows (
    so_extract_row_id TEXT PRIMARY KEY,
    import_batch_id   TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    source_record_key TEXT,
    row_hash          TEXT,

    -- ---- the 31 workbook columns, in file order ----
    affiliate                    TEXT     ,   -- AFFILIATE  (text, longest 20, 1386 populated)
    document_number              INTEGER  ,   -- DOCUMENT_NUMBER  (whole number, 1386 populated)
    posting_date                 TEXT     ,   -- POSTING_DATE  (datetime, ISO 8601, 1386 populated)
    actual_order_date_user_input TEXT     ,   -- ACTUAL_ORDER_DATE_USER_INPUT  (datetime, ISO 8601, 1386 populated)
    customer_code                TEXT     ,   -- CUSTOMER_CODE  (text, longest 6, 1386 populated)
    customer_name                TEXT     ,   -- CUSTOMER_NAME  (text, longest 73, 1386 populated)
    user_name                    TEXT     ,   -- USER_NAME  (text, longest 16, 1386 populated)
    create_date                  TEXT     ,   -- CREATE_DATE  (datetime, ISO 8601, 1386 populated)
    create_time                  TEXT     ,   -- CREATE_TIME  (text, longest 8, 1386 populated)
    create_date_time             TEXT     ,   -- CREATE_DATE_TIME  (datetime, ISO 8601, 1386 populated)
    approval_date1               TEXT     ,   -- APPROVAL_DATE1  (datetime, ISO 8601, 1386 populated)
    approval_date                TEXT     ,   -- APPROVAL_DATE  (datetime, ISO 8601, 1386 populated)
    approval_time                TEXT     ,   -- APPROVAL_TIME  (text, longest 8, 1386 populated)
    approval_date_time           TEXT     ,   -- APPROVAL_DATE_TIME  (datetime, ISO 8601, 1386 populated)
    finance_variance             REAL     ,   -- FINANCE_VARIANCE  (decimal, 1386 populated)
    delayed_raising_orders       REAL     ,   -- DELAYED_RAISING_ORDERS  (decimal, 1386 populated)
    approval_status              TEXT     ,   -- APPROVAL_STATUS  (text, longest 7, 1386 populated)
    approver                     TEXT     ,   -- APPROVER  (text, longest 7, 1386 populated)
    credit_hold_date             TEXT     ,   -- CREDIT_HOLD_DATE  (datetime, ISO 8601, 793 populated)
    credit_hold_name             TEXT     ,   -- CREDIT_HOLD_NAME  (text, longest 20, 793 populated)
    released_flag                TEXT     ,   -- RELEASED_FLAG  (text, longest 1, 793 populated)
    release_reason_code          TEXT     ,   -- RELEASE_REASON_CODE  (text, longest 26, 793 populated)
    credit_hold_release_date     TEXT     ,   -- CREDIT_HOLD_RELEASE_DATE  (datetime, ISO 8601, 793 populated)
    hold_released_by             TEXT     ,   -- HOLD_RELEASED_BY  (text, longest 14, 793 populated)
    credit_variance              REAL     ,   -- CREDIT_VARIANCE  (decimal, 793 populated)
    invoice_creation_date        TEXT     ,   -- INVOICE_CREATION_DATE  (datetime, ISO 8601, 1380 populated)
    invoice_variance             REAL     ,   -- INVOICE_VARIANCE  (decimal, 1380 populated)
    line_number                  INTEGER  ,   -- LINE_NUMBER  (whole number, 1386 populated)
    ordered_item                 TEXT     ,   -- ORDERED_ITEM  (text, longest 12, 1386 populated)
    loading_authority_date       TEXT     ,   -- LOADING_AUTHORITY_DATE  (datetime, ISO 8601, 1386 populated)
    loading_authority_variance   REAL         -- LOADING_AUTHORITY_VARIANCE  (decimal, 1386 populated)
,

    -- ---- anything the workbook adds later ----
    extra_json TEXT,

    ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id) ON DELETE CASCADE,
    UNIQUE(import_batch_id, source_row_number)
);

CREATE TABLE po_extract_rows (
    po_extract_row_id TEXT PRIMARY KEY,
    import_batch_id   TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    source_record_key TEXT,
    row_hash          TEXT,

    -- ---- the 29 workbook columns, in file order ----
    purchase_number                   TEXT     ,   -- purchase Number  (text, longest 4, 45 populated)
    req_description                   TEXT     ,   -- Req Description  (text, longest 115, 45 populated)
    nature                            TEXT     ,   -- NATURE  (text, longest 7, 45 populated)
    original_creation_date            TEXT     ,   -- ORIGINAL_CREATION_DATE  (datetime, ISO 8601, 45 populated)
    submission_for_approval_date      TEXT     ,   -- SUBMISSION_FOR_APPROVAL_DATE  (datetime, ISO 8601, 45 populated)
    time_diff_raisepo_toaprovalsubmit REAL     ,   -- TIME_DIFF_RAISEPO_TOAPROVALSUBMIT  (decimal, 45 populated)
    purchase_order_created_by         TEXT     ,   -- PURCHASE_ORDER_CREATED_BY  (text, longest 16, 45 populated)
    first_approval_date               TEXT     ,   -- FIRST_APPROVAL_DATE  (datetime, ISO 8601, 45 populated)
    second_approval_date              TEXT     ,   -- SECOND_APPROVAL_DATE  (datetime, ISO 8601, 45 populated)
    third_approval_date               TEXT     ,   -- THIRD_APPROVAL_DATE  (datetime, ISO 8601, 45 populated)
    fourth_approval_date              TEXT     ,   -- FOURTH_APPROVAL_DATE  (datetime, ISO 8601, 45 populated)
    fifth_approval_date               TEXT     ,   -- FIFTH_APPROVAL_DATE  (always empty in this extract, 0 populated)
    sixth_approval_date               TEXT     ,   -- SIXTH_APPROVAL_DATE  (always empty in this extract, 0 populated)
    seventh_approval_date             TEXT     ,   -- SEVENTH_APPROVAL_DATE  (always empty in this extract, 0 populated)
    first_approver                    TEXT     ,   -- FIRST_APPROVER  (text, longest 27, 45 populated)
    second_approver                   TEXT     ,   -- SECOND_APPROVER  (text, longest 27, 45 populated)
    third_approver                    TEXT     ,   -- THIRD_APPROVER  (text, longest 22, 45 populated)
    fourth_approver                   TEXT     ,   -- FOURTH_APPROVER  (text, longest 26, 45 populated)
    fifth_approver                    TEXT     ,   -- FIFTH_APPROVER  (always empty in this extract, 0 populated)
    sixth_approver                    TEXT     ,   -- SIXTH_APPROVER  (always empty in this extract, 0 populated)
    seventh_approver                  TEXT     ,   -- SEVENTH_APPROVER  (always empty in this extract, 0 populated)
    first_approvals_variance          REAL     ,   -- FIRST_APPROVALS_VARIANCE  (decimal, 45 populated)
    second_approvals_variance         REAL     ,   -- SECOND_APPROVALS_VARIANCE  (decimal, 45 populated)
    third_approvals_variance          REAL     ,   -- THIRD_APPROVALS_VARIANCE  (decimal, 45 populated)
    fourth_approvals_variance         REAL     ,   -- FOURTH_APPROVALS_VARIANCE  (decimal, 45 populated)
    fifth_approvals_variance          REAL     ,   -- FIFTH_APPROVALS_VARIANCE  (always empty in this extract, 0 populated)
    sixth_approvals_variance          REAL     ,   -- SIXTH_APPROVALS_VARIANCE  (always empty in this extract, 0 populated)
    seventh_approvals_variance        REAL     ,   -- SEVENTH_APPROVALS_VARIANCE  (always empty in this extract, 0 populated)
    authorization_status              TEXT         -- AUTHORIZATION_STATUS  (text, longest 8, 45 populated)
,

    -- ---- anything the workbook adds later ----
    extra_json TEXT,

    ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_batch_id) REFERENCES import_batches(import_batch_id) ON DELETE CASCADE,
    UNIQUE(import_batch_id, source_row_number)
);

CREATE TABLE auth_federated_identities (
    federated_identity_id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    provider TEXT NOT NULL
        CHECK(provider IN (
            'GOOGLE',
            'MICROSOFT',
            'APPLE'
        )),

    issuer TEXT NOT NULL,

    provider_subject TEXT NOT NULL,

    provider_tenant_id TEXT,

    provider_email TEXT COLLATE NOCASE,

    provider_email_verified INTEGER NOT NULL DEFAULT 0
        CHECK(provider_email_verified IN (0,1)),

    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK(status IN (
            'ACTIVE',
            'REVOKED'
        )),

    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    last_login_at TEXT,

    revoked_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE,

    UNIQUE(provider, issuer, provider_subject),

    CHECK(
        status != 'REVOKED'
        OR revoked_at IS NOT NULL
    )
);

CREATE TABLE auth_email_domain_policies (
    domain_policy_id TEXT PRIMARY KEY,

    domain TEXT NOT NULL COLLATE NOCASE,

    policy_type TEXT NOT NULL
        CHECK(policy_type IN (
            'INTERNAL_PROTECTED',
            'SELF_REGISTRATION_BLOCKED'
        )),

    reason TEXT,

    active INTEGER NOT NULL DEFAULT 1
        CHECK(active IN (0,1)),

    created_by_user_id TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (created_by_user_id)
        REFERENCES users(user_id)
        ON DELETE SET NULL,

    UNIQUE(domain, policy_type),

    CHECK(instr(domain, '@') = 0),

    CHECK(length(trim(domain)) > 2)
);

CREATE TABLE customer_access_requests (
    access_request_id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    identity_method TEXT NOT NULL
        CHECK(identity_method IN (
            'EMAIL_PASSWORD',
            'GOOGLE',
            'MICROSOFT',
            'APPLE'
        )),

    federated_identity_id TEXT,

    email_at_request TEXT NOT NULL COLLATE NOCASE
        CHECK(instr(email_at_request, '@') > 1),

    email_domain TEXT NOT NULL COLLATE NOCASE,

    requested_account_id TEXT,

    requested_contact_id TEXT,

    company_name TEXT,

    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN (
            'PENDING',
            'APPROVED',
            'REJECTED',
            'CANCELLED'
        )),

    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    identity_verified_at TEXT,

    reviewed_at TEXT,

    reviewed_by_user_id TEXT,

    decision_reason TEXT,

    approved_membership_id TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE,

    FOREIGN KEY (federated_identity_id)
        REFERENCES auth_federated_identities(federated_identity_id)
        ON DELETE SET NULL,

    FOREIGN KEY (requested_account_id)
        REFERENCES accounts(account_id)
        ON DELETE SET NULL,

    FOREIGN KEY (requested_contact_id)
        REFERENCES contacts(contact_id)
        ON DELETE SET NULL,

    FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users(user_id)
        ON DELETE SET NULL,

    FOREIGN KEY (approved_membership_id)
        REFERENCES customer_portal_memberships(portal_membership_id)
        ON DELETE SET NULL,

    CHECK(
        requested_account_id IS NOT NULL
        OR length(trim(COALESCE(company_name, ''))) > 0
    ),

    CHECK(
        identity_method = 'EMAIL_PASSWORD'
        OR federated_identity_id IS NOT NULL
    )
);

CREATE TABLE "purchase_orders" (
    purchase_order_id TEXT PRIMARY KEY,
    document_number TEXT NOT NULL,
    affiliate_id TEXT,
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
    UNIQUE(affiliate_id, document_number),
    CHECK(submitted_for_approval_at IS NULL OR submitted_for_approval_at >= po_created_at)
);

CREATE TABLE "purchase_order_lines" (
    purchase_order_line_id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK(line_number > 0),
    product_id TEXT NOT NULL,
    quantity REAL CHECK(quantity IS NULL OR quantity >= 0),
    unit_cost REAL CHECK(unit_cost IS NULL OR unit_cost >= 0),
    line_value REAL CHECK(line_value IS NULL OR line_value >= 0),
    FOREIGN KEY (purchase_order_id) REFERENCES "purchase_orders"(purchase_order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    UNIQUE(purchase_order_id, line_number)
);

CREATE TABLE ai_providers (
    ai_provider_id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('ANTHROPIC','OPENAI','AZURE_OPENAI','GOOGLE','OTHER')),
    base_url TEXT,
    model TEXT NOT NULL,
    secret_name TEXT NOT NULL,
    max_output_tokens INTEGER CHECK(max_output_tokens IS NULL OR max_output_tokens > 0),
    temperature REAL CHECK(temperature IS NULL OR (temperature >= 0 AND temperature <= 2)),
    purpose TEXT NOT NULL CHECK(purpose IN ('ASSISTANT','CLASSIFICATION','BOTH')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    last_verified_at TEXT,
    last_verify_status TEXT CHECK(last_verify_status IS NULL OR last_verify_status IN ('OK','UNAUTHORISED','UNREACHABLE','ERROR')),
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE bot_conversations (
    bot_conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ai_provider_id TEXT,
    title TEXT,
    entity_type TEXT,
    entity_id TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_message_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (ai_provider_id) REFERENCES ai_providers(ai_provider_id) ON DELETE SET NULL
);

CREATE TABLE bot_messages (
    bot_message_id TEXT PRIMARY KEY,
    bot_conversation_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
    role TEXT NOT NULL CHECK(role IN ('USER','ASSISTANT','SYSTEM','TOOL')),
    content TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
    latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_conversation_id) REFERENCES bot_conversations(bot_conversation_id) ON DELETE CASCADE,
    UNIQUE(bot_conversation_id, sequence_no)
);

CREATE TABLE channel_connections (
    channel_connection_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK(channel IN ('WHATSAPP','EMAIL')),
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_identifier TEXT NOT NULL,
    affiliate_id TEXT,
    secret_name TEXT NOT NULL,
    webhook_secret_name TEXT,
    status TEXT NOT NULL CHECK(status IN ('DRAFT','CONNECTED','ERROR','DISABLED')),
    last_polled_at TEXT,
    last_error TEXT,
    auto_create_case INTEGER NOT NULL DEFAULT 0 CHECK(auto_create_case IN (0,1)),
    default_case_category_id TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(affiliate_id) ON DELETE SET NULL,
    FOREIGN KEY (default_case_category_id) REFERENCES case_categories(case_category_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(channel, account_identifier)
);

CREATE TABLE channel_messages (
    channel_message_id TEXT PRIMARY KEY,
    channel_connection_id TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
    from_address TEXT,
    to_address TEXT,
    subject TEXT,
    body TEXT,
    received_at TEXT NOT NULL,
    account_id TEXT,
    contact_id TEXT,
    case_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('RECEIVED','CLASSIFIED','LINKED','IGNORED','FAILED')),
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_connection_id) REFERENCES channel_connections(channel_connection_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
    FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
    FOREIGN KEY (case_id) REFERENCES service_cases(case_id) ON DELETE SET NULL,
    UNIQUE(channel_connection_id, external_message_id)
);

CREATE TABLE message_classifications (
    message_classification_id TEXT PRIMARY KEY,
    channel_message_id TEXT NOT NULL,
    ai_provider_id TEXT,
    model TEXT,
    suggested_case_type TEXT CHECK(suggested_case_type IS NULL OR suggested_case_type IN
      ('ENQUIRY','COMPLAINT','REQUEST','INCIDENT','FEEDBACK','COMPLIMENT')),
    suggested_case_category_id TEXT,
    suggested_priority TEXT CHECK(suggested_priority IS NULL OR suggested_priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    suggested_account_id TEXT,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    rationale TEXT,
    review_status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(review_status IN ('PENDING','ACCEPTED','CORRECTED','REJECTED')),
    reviewed_by_user_id TEXT,
    reviewed_at TEXT,
    final_case_type TEXT,
    final_case_category_id TEXT,
    final_priority TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_message_id) REFERENCES channel_messages(channel_message_id) ON DELETE CASCADE,
    FOREIGN KEY (ai_provider_id) REFERENCES ai_providers(ai_provider_id) ON DELETE SET NULL,
    FOREIGN KEY (suggested_case_category_id) REFERENCES case_categories(case_category_id) ON DELETE SET NULL,
    FOREIGN KEY (final_case_category_id) REFERENCES case_categories(case_category_id) ON DELETE SET NULL,
    FOREIGN KEY (suggested_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(channel_message_id)
);

CREATE TABLE job_title_access_role_mappings (
    mapping_id TEXT PRIMARY KEY,
    job_title_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id TEXT,
    FOREIGN KEY (job_title_id) REFERENCES job_titles(job_title_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES access_roles(role_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(job_title_id, role_id)
);

CREATE TABLE job_title_workflow_role_mappings (
    mapping_id TEXT PRIMARY KEY,
    job_title_id TEXT NOT NULL,
    workflow_role_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id TEXT,
    FOREIGN KEY (job_title_id) REFERENCES job_titles(job_title_id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_role_id) REFERENCES workflow_roles(workflow_role_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE(job_title_id, workflow_role_id)
);

CREATE TABLE channel_credentials (
    channel_connection_id TEXT NOT NULL,
    purpose TEXT NOT NULL
        CHECK(purpose IN (
            'NOTIFICATION_EMAIL',
            'INQUIRY_EMAIL',
            'WHATSAPP'
        )),
    auth_provider TEXT NOT NULL
        CHECK(auth_provider IN ('MICROSOFT','META')),
    sealed_refresh_token TEXT,
    sealed_access_token TEXT,
    provider_account_id TEXT,
    provider_aux_id TEXT,
    granted_scopes TEXT,
    sync_cursor TEXT,
    connected_at TEXT,
    connected_by_user_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (channel_connection_id, purpose),

    FOREIGN KEY (channel_connection_id)
        REFERENCES channel_connections(channel_connection_id)
        ON DELETE CASCADE,

    FOREIGN KEY (connected_by_user_id)
        REFERENCES users(user_id)
        ON DELETE SET NULL
);

CREATE TABLE channel_provider_settings (
    provider TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    sealed_client_secret TEXT NOT NULL,
    configured_by_user_id TEXT,
    configured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (configured_by_user_id)
        REFERENCES users(user_id)
        ON DELETE SET NULL
);

CREATE INDEX idx_user_assignments_user ON user_assignments(user_id, effective_from);

CREATE INDEX idx_user_roles_user ON user_roles(user_id, active);

CREATE INDEX idx_accounts_name ON accounts(account_name);

CREATE INDEX idx_contacts_account ON contacts(account_id);

CREATE INDEX idx_leads_owner_status ON leads(owner_user_id, status);

CREATE INDEX idx_opportunities_owner_status ON opportunities(owner_user_id, status);

CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id);

CREATE INDEX idx_cases_assignee_status ON service_cases(assigned_user_id, status);

CREATE INDEX idx_cases_account ON service_cases(account_id, raised_at);

CREATE INDEX idx_workflow_entity ON workflow_instances(entity_type, entity_id);

CREATE INDEX idx_sla_entity ON sla_instances(entity_type, entity_id, status);

CREATE INDEX idx_import_rows_batch ON import_rows(import_batch_id, row_status);

CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, event_at);

CREATE INDEX idx_auth_sessions_user_status ON auth_sessions(user_id, status, expires_at);

CREATE INDEX idx_login_attempts_email_time ON login_attempts(email_attempted, attempted_at);

CREATE INDEX idx_user_assignments_scope ON user_assignments(assignment_level, country_id, affiliate_id, business_unit_id, active);

CREATE INDEX idx_user_role_scopes_scope ON user_role_scopes(scope_type, country_id, affiliate_id, business_unit_id, team_id);

CREATE INDEX idx_workflow_role_assignments_scope ON workflow_role_assignments(workflow_role_id, scope_type, country_id, affiliate_id, business_unit_id, active);

CREATE INDEX idx_authority_rules_assignment ON approval_authority_rules(workflow_role_assignment_id, process_type, active);

CREATE INDEX idx_product_categories_group ON product_categories(product_group_id, active);

CREATE INDEX idx_products_category ON products(product_category_id, active);

CREATE INDEX idx_portal_membership_account ON customer_portal_memberships(account_id, status);

CREATE INDEX idx_workflow_stage_assignees_instance ON workflow_stage_assignees(workflow_stage_instance_id, status);

CREATE INDEX ix_sla_breaches_accountable
    ON sla_breaches(accountable_user_id, breached_at);

CREATE INDEX ix_sla_breaches_open
    ON sla_breaches(resolved_at, breached_at);

CREATE INDEX ix_sla_escalation_recipient
    ON sla_escalation_events(recipient_user_id, triggered_at);

CREATE INDEX idx_so_account_date ON sales_orders(account_id, order_created_at);

CREATE INDEX ix_attachments_portal
  ON entity_attachments(entity_type, entity_id, customer_visible);

CREATE INDEX ix_survey_invitations_status
  ON survey_invitations(status, issued_at);

CREATE INDEX ix_so_extract_document ON so_extract_rows(affiliate, document_number, line_number);

CREATE INDEX ix_so_extract_created  ON so_extract_rows(create_date_time);

CREATE INDEX ix_po_extract_document ON po_extract_rows(purchase_number);

CREATE INDEX ix_po_extract_created  ON po_extract_rows(original_creation_date);

CREATE INDEX idx_auth_federated_user_status
    ON auth_federated_identities(
        user_id,
        status
    );

CREATE INDEX idx_auth_federated_email
    ON auth_federated_identities(
        provider_email COLLATE NOCASE
    );

CREATE INDEX idx_auth_federated_provider_tenant
    ON auth_federated_identities(
        provider,
        provider_tenant_id
    );

CREATE INDEX idx_auth_domain_policy_lookup
    ON auth_email_domain_policies(
        domain COLLATE NOCASE,
        active,
        policy_type
    );

CREATE INDEX idx_customer_access_status_submitted
    ON customer_access_requests(
        status,
        submitted_at
    );

CREATE INDEX idx_customer_access_user_status
    ON customer_access_requests(
        user_id,
        status
    );

CREATE INDEX idx_customer_access_account_status
    ON customer_access_requests(
        requested_account_id,
        status
    );

CREATE UNIQUE INDEX uq_customer_access_pending_account
    ON customer_access_requests(
        user_id,
        requested_account_id
    )
    WHERE status = 'PENDING'
      AND requested_account_id IS NOT NULL;

CREATE INDEX idx_po_affiliate_date ON purchase_orders(affiliate_id, po_created_at);

CREATE UNIQUE INDEX ux_po_group_document
  ON purchase_orders(document_number)
  WHERE affiliate_id IS NULL;

CREATE INDEX ix_bot_conv_user       ON bot_conversations(user_id, last_message_at);

CREATE INDEX ix_channel_conn_status ON channel_connections(channel, status);

CREATE INDEX ix_channel_msg_queue   ON channel_messages(channel_connection_id, status, received_at);

CREATE INDEX ix_channel_msg_account ON channel_messages(account_id, received_at);

CREATE INDEX ix_channel_msg_case    ON channel_messages(case_id);

CREATE INDEX ix_msg_class_review    ON message_classifications(review_status, created_at);

CREATE INDEX ix_ai_providers_purpose ON ai_providers(purpose, active);

CREATE INDEX ix_jt_role_map_title
    ON job_title_access_role_mappings(job_title_id, active);

CREATE INDEX ix_jt_wfrole_map_title
    ON job_title_workflow_role_mappings(job_title_id, active);

CREATE UNIQUE INDEX ux_affiliates_extract_code
  ON affiliates(extract_code) WHERE extract_code IS NOT NULL;

CREATE INDEX idx_channel_credentials_purpose
    ON channel_credentials(purpose, updated_at);

CREATE VIEW v_user_access AS
SELECT
    u.user_id,
    u.user_type,
    u.display_name,
    u.email,
    ar.role_name,
    urs.scope_type,
    urs.country_id,
    urs.affiliate_id,
    urs.business_unit_id,
    urs.team_id,
    ur.active AS role_active
FROM users u
JOIN user_roles ur ON ur.user_id = u.user_id
JOIN access_roles ar ON ar.role_id = ur.role_id
LEFT JOIN user_role_scopes urs ON urs.user_role_id = ur.user_role_id
WHERE u.status = 'ACTIVE' AND ur.active = 1 AND ar.active = 1;

CREATE VIEW v_open_sla AS
SELECT
    si.sla_instance_id,
    sr.rule_name,
    si.entity_type,
    si.entity_id,
    si.started_at,
    si.target_at,
    si.warning_at,
    si.status,
    u.display_name AS accountable_user,
    t.team_name AS accountable_team
FROM sla_instances si
JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
LEFT JOIN users u ON u.user_id = si.accountable_user_id
LEFT JOIN teams t ON t.team_id = si.accountable_team_id
WHERE si.status IN ('RUNNING','PAUSED','BREACHED');

CREATE VIEW v_import_summary AS
SELECT
    ib.import_batch_id,
    ib.import_type,
    ib.original_filename,
    ib.uploaded_at,
    u.display_name AS uploaded_by,
    ib.rows_received,
    ib.rows_new,
    ib.rows_changed,
    ib.rows_exact_duplicate,
    ib.rows_rejected,
    ib.status
FROM import_batches ib
JOIN users u ON u.user_id = ib.uploaded_by_user_id;

CREATE VIEW v_customer_360 AS
SELECT
    a.account_id,
    a.account_name,
    a.account_type,
    a.segment,
    COUNT(DISTINCT l.lead_id) AS lead_count,
    COUNT(DISTINCT o.opportunity_id) AS opportunity_count,
    COUNT(DISTINCT sc.case_id) AS case_count,
    COUNT(DISTINCT so.sales_order_id) AS sales_order_count
FROM accounts a
LEFT JOIN leads l ON l.account_id = a.account_id
LEFT JOIN opportunities o ON o.account_id = a.account_id
LEFT JOIN service_cases sc ON sc.account_id = a.account_id
LEFT JOIN sales_orders so ON so.account_id = a.account_id
GROUP BY a.account_id, a.account_name, a.account_type, a.segment;

CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: updates are not permitted');
END;

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: deletes are not permitted');
END;

-- Standalone repair for a database missing only OIDC transaction storage.
-- Run this file in the hass-cms Turso SQL console. No transaction wrappers
-- are needed. It neither rebuilds nor updates identity/customer-request data.
-- Do not run migration 001 or 002 as a prerequisite for this repair.

CREATE TABLE IF NOT EXISTS auth_oidc_transactions (
  transaction_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT','APPLE')),
  purpose TEXT NOT NULL CHECK(purpose IN ('SIGN_IN','REGISTER','LINK')),
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at >= created_at)
);


-- Targeted notification/SLA read indexes for the observed hass-cms schema.
-- Manual Turso SQL console migration; no other migration is a prerequisite.
-- Adds no columns, changes no application rows, and creates no UNIQUE rules.
-- Inspect existing index definitions with the companion diagnostic first.
-- IF NOT EXISTS preserves an existing index of the same name; it does not
-- reconcile a name that already has a different definition.

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(user_id, notification_type, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sla_instances_due
  ON sla_instances(status, target_at);
CREATE INDEX IF NOT EXISTS idx_sla_instances_warning
  ON sla_instances(status, warning_at);
CREATE INDEX IF NOT EXISTS idx_sla_timer_instance_event
  ON sla_timer_events(sla_instance_id, event_type);


