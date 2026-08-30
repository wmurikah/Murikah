# Phase 4 authentication architecture

## Baseline inspected

Phase 4 starts at `532e26441855f0e464cfa17e1ff4fad52ab7249d`.

The existing schema already provides `users` (one person, `INTERNAL`/`EXTERNAL`, unique case-insensitive email and lifecycle status), one password row per user in `auth_credentials`, hashed application sessions in `auth_sessions`, `login_attempts`, append-only `audit_events`, single-use `email_verification_tokens` and `password_reset_tokens`, `mfa_methods`, and account-scoped `customer_portal_memberships`. The existing password flow performs generic failures, PBKDF2 verification, lockout accounting, audit writes, one shared CMS session, and internal/external routing. Portal access remains gated by the existing active membership resolver.

`source_identities` maps source-system usernames and is not an authentication-provider identity model. No OAuth transaction, durable provider-subject link, or pending customer access-request model existed. Password-reset storage existed, but no CMS request/completion routes or delivery integration existed.

## Additive delta

Migration `cms/db/migrations/001_phase4_identity.sql` adds only:

- `auth_federated_identities`, uniquely keyed by provider subject and by user/provider;
- short-lived, single-use `auth_oidc_transactions` for state, nonce and PKCE continuity;
- `customer_access_requests`, including one pending request per email.

No existing table is dropped or rebuilt. Forward fix is the rollback strategy: identity and request rows are additive and existing password login is independent of them.

## Identity and linking policy

A `users` row remains the person. Provider identities sit below it. A provider subject is durable; provider email is metadata. A linked subject can never move users. A new verified Microsoft/Google identity may link only to an existing active, verified exact-email user. Apple signs in an already linked identity or an eligible existing external identity; it never starts customer registration. Conflicts stop rather than merge.

The centralized policy classifies normalized ASCII email as protected internal, consumer, or corporate. `hasspetroleum.com` is protected: SSO may resolve an existing provisioned internal user, but registration cannot create one. Consumer domains cannot submit customer access requests. Corporate identity creates only a pending request; it creates neither a user nor a portal membership and grants no tenant data.

## OIDC security

Authorization Code flow uses state, nonce and PKCE. State and nonce are keyed hashes at rest, transactions expire after ten minutes and are consumed once. Callback processing exchanges the code server-side and uses `jose` remote JWKS verification for signature, issuer, audience and expiry before checking nonce and verified email. Provider secrets remain Worker secrets. Successful provider authentication creates the existing `auth_sessions` row and cookie.

## Password recovery

Reset tokens contain 256 random bits. Only an HMAC is stored. Responses are generic. Tokens expire after 30 minutes, are single-use, and older pending tokens are revoked. Completion updates the existing PBKDF2 credential, clears lockout, records an audit event, and revokes all active sessions. Delivery uses an optional dedicated `CMS_AUTH_MAIL_ENDPOINT`; no raw token is logged or audited.

## Approval boundary

Approval UI and mutation are deliberately pending: approval must select an existing account, authorized portal role and appropriate contact under business policy. Implementing a guess would risk cross-tenant access. Until that workflow is approved, requests remain pending and cannot create memberships.
