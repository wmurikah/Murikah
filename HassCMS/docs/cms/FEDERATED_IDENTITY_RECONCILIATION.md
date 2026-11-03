# Federated identity resolution against the observed CMS schema

Sign-in uses the 2 November 2026 schema's `federated_identity_id` and required
`issuer`. No database migration is needed on that observed schema.

## Identity and revocation

The callback passes the issuer and subject from the cryptographically verified
provider token. The repository validates the provider/issuer, a nonempty subject
and verified email before either the linked or automatic-link path. It resolves
only the exact `(provider, issuer, provider_subject)` tuple; issuer values are
not silently rewritten or guessed from email or provider name.

Existing links must have `status='ACTIVE'` and `revoked_at IS NULL`. The user
must be ACTIVE and email-verified. A revoked/inconsistent link is refused, not
ignored so the email fallback can recreate it. Metadata updates target the
specific primary key, leaving other issuers' identities and user email/ownership
unchanged. Provider email remains metadata; it cannot move a linked subject to
another user.

## Automatic linking

Preserve the existing policy for an identity without a link: a verified Google
or Microsoft email can link only to a pre-existing ACTIVE, email-verified user.
No user is provisioned by sign-in. If that user already has a link for this
provider, including a revoked link or a different issuer/subject, automatic
replacement is refused and requires explicit review.

Apple may sign in through an existing eligible link. A new automatic Apple
link additionally requires an EXTERNAL user with an ACTIVE customer portal
membership. Apple does not initiate customer registration.

The identity insert and its audit event share a write transaction, so retries
cannot create competing links and a failed audit cannot leave an unaudited
link. New rows provide the observed key, issuer and ACTIVE lifecycle fields.

## Session issuance

After resolution, the callback checks the exact identity tuple, primary key,
owner, revocation and user eligibility again in the same write transaction that
creates the application session and success audit. Revocation or suspension
between resolution and session creation therefore prevents that login. The
callback only sets the cookie after successful session creation and uses a
mutable redirect response to support the Set-Cookie header.

This blocks new federated logins; it does not alter the existing application
session lifetime or automatically revoke previously issued sessions. Those
continue to use the application's session-revocation controls.

## Validation and rollout

Regression tests use the observed issuer-qualified uniqueness, lifecycle and
foreign-key constraints. They reproduce revoked-link acceptance, isolate
same-subject identities under different issuers, verify automatic linking,
claim/user eligibility, rollback, retries and session-time revocation checks.

Deploy the CMS code after merge. Keep the standalone OIDC transaction table
repair if it was already applied; apply that repair first if storage is still
missing. Provider secrets, registered callback URLs and live provider token
verification are operational prerequisites. Local regression tests do not
establish that a live provider has been configured correctly.
