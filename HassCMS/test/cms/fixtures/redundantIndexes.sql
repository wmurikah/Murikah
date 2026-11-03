-- Observed definitions from the operator’s 2026-11-02 schema export.
-- Schema only; no customer data. Dependencies are not included.
CREATE TABLE business_units (
    business_unit_id TEXT PRIMARY KEY,
    business_unit_code TEXT NOT NULL UNIQUE,
    business_unit_name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE INDEX idx_users_email ON users(email);

CREATE INDEX idx_accounts_name ON accounts(account_name);

CREATE INDEX idx_accounts_oracle_code ON accounts(oracle_customer_code);

CREATE INDEX idx_snapshots_entity ON record_snapshots(entity_type, entity_id, version_no);

CREATE INDEX idx_business_units_code ON business_units(business_unit_code);

CREATE INDEX ix_sla_escalation_instance
    ON sla_escalation_events(sla_instance_id, escalation_level);

CREATE INDEX ix_sla_escalation_recipient
    ON sla_escalation_events(recipient_user_id, triggered_at);

CREATE INDEX ix_so_extract_batch    ON so_extract_rows(import_batch_id, source_row_number);

CREATE INDEX ix_so_extract_document ON so_extract_rows(affiliate, document_number, line_number);

CREATE INDEX ix_so_extract_created  ON so_extract_rows(create_date_time);

CREATE INDEX ix_po_extract_batch    ON po_extract_rows(import_batch_id, source_row_number);

CREATE INDEX ix_po_extract_document ON po_extract_rows(purchase_number);

CREATE INDEX ix_po_extract_created  ON po_extract_rows(original_creation_date);

CREATE INDEX ix_bot_msg_conv        ON bot_messages(bot_conversation_id, sequence_no);

