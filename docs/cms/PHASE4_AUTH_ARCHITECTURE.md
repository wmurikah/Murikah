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

## Live Turso reconciliation

**Reconciliation start:** `cf48dbbd63a516c1914f86ba36ef8b6430dad452`.

The merged repository migration used `identity_id`, durable uniqueness on provider plus subject, and `request_id`/`email` request columns. The verified live database instead used `federated_identity_id`, an explicit issuer and lifecycle, uniqueness on provider + issuer + subject, and an `access_request_id` request model whose `user_id` was required. Live also introduced `auth_email_domain_policies` with 16 active policies, while the repository retained a shorter hard-coded list. These differences were confirmed drift, not equivalent aliases.

### Canonical model and preservation

| Table                        | Repository before reconciliation                                  | Verified live before reconciliation                                             | Canonical target                                                                                 | Preservation                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `auth_federated_identities`  | `identity_id`; provider + subject; one identity per user/provider | `federated_identity_id`; issuer; status/revocation; provider + issuer + subject | Verified live shape                                                                              | No rebuild; live had zero rows and its stronger shape is retained.                                                           |
| `auth_email_domain_policies` | Hard-coded application sets                                       | 16 active policy rows                                                           | Verified live table is authoritative                                                             | All policy rows remain untouched.                                                                                            |
| `customer_access_requests`   | Nullable user; pre-approval request; repository column names      | Required user and richer approval references                                    | `access_request_id`, nullable user, verified issuer/subject evidence, richer approval references | Create-copy-verify-rename operator script maps all existing live fields and provider evidence. Verified live count was zero. |
| `auth_oidc_transactions`     | Short-lived state/nonce/PKCE table                                | Absent                                                                          | Repository security table with atomic consumption                                                | Created additively; no existing data to migrate.                                                                             |

Provider identity is now `(provider, issuer, provider_subject)`. The issuer comes only from the cryptographically verified ID token; it is never inferred from email or domain. Multiple identities from the same provider may link to one user when issuers differ, while the canonical unique constraint prevents one external identity from belonging to two users.

Domain classification queries the active live policy row through one server-side service. Normalization and confusable rejection remain pure. A policy query failure propagates and registration fails closed with a temporary-unavailability response.

The signed registration grant now carries verified provider, issuer, subject and email. A pending request keeps that evidence but creates no `users`, `accounts`, or `customer_portal_memberships` row. The partial unique indexes prevent concurrent pending duplicates by normalized email and by verified provider identity. Tenant access remains impossible until the separately approved membership mutation exists.

OIDC state and nonce remain keyed hashes. The short-lived PKCE verifier remains only in `auth_oidc_transactions`. Consumption is a single conditional `UPDATE … RETURNING`, so callback replay and concurrent callback attempts cannot both succeed.

The live forward artifact is `PHASE4_LIVE_RECONCILIATION.sql`; the read-only before/after evidence block is `PHASE4_LIVE_VERIFICATION.sql`. The original `001` file remains documented history and must not be applied to the already-reconciled live database.
