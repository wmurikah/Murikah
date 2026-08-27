/**
 * The DDL the CMS authentication tests create their database from.
 *
 * Copied VERBATIM from the operator's hass_cms_turso_v1_FINAL.sql: the tables
 * on the authentication path, the organisation master data Build Prompt 05
 * administers, and every table those reach through a foreign key. Constraints
 * are included exactly as written, so a test proves the code satisfies the real
 * CHECK and UNIQUE rules rather than a relaxed copy of them.
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
`;
