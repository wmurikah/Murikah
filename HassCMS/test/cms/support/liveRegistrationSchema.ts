/** Registration tables and indexes from the operator's 2 November 2026 schema export.
 * Keep the real issuer, lifecycle, user NOT NULL and identity-method constraints.
 * Used after removing the obsolete versions from the historical base fixture.
 */
export const LIVE_REGISTRATION_DDL = `
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
`;
