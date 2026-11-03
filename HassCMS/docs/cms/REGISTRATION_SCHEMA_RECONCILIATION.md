# Customer registration: observed request model

The 2 November 2026 hass-cms schema export is the contract for registration.
Registration now uses `access_request_id`, `email_at_request`, `identity_method`
and `federated_identity_id`. It does not insert obsolete request columns or
rebuild existing tables. No database migration is required for this change on
that observed schema; do not run migrations 001/002 to deploy this fix.

## Pending applicant lifecycle

Only a verified corporate Google or Microsoft identity may submit a request.
The OIDC callback signs a ten-minute registration grant containing the verified
provider subject, exact issuer, email and tenant metadata. The registration API
uses that grant, not email/provider fields supplied by the browser. Grants from
before this release lack the issuer binding and require fresh verification.

For a new identity/email, one write transaction creates:

1. An `EXTERNAL` user with status `INVITED`, the supplied contact display name,
   and the timestamp of provider verification. Verification is not activation.
2. An `ACTIVE` provider link keyed by `(provider, issuer, provider_subject)`,
   pointing to that invited user. It records verified provider metadata and
   cannot, on its own, authenticate an invited user.
3. A `PENDING` customer access request linked to both rows, plus its audit event.
   Company name is stored on the request. Contact name is retained on the new
   user and in request audit metadata, rather than an absent request column.

Registration creates no password, session, access role, account, contact or
portal membership. Existing login and identity resolution require an ACTIVE
user; invited applicants cannot enter a customer workspace. Customer account
selection, activation and membership approval remain separate administrative
work, and no approval automation is introduced here.

A write transaction serializes lookup and creation. Repeating the same verified
identity returns its existing pending request, without overwriting the original
company details or adding duplicate audit entries. A failure rolls back the
request, provider link and newly created user together.

## Existing identities and conflicts

An exact existing provider link can be reused only when it is active,
non-revoked, belongs to an external INVITED/ACTIVE user, and that user's email
matches the verified email. A suspended/inactive/internal user or revoked link
is refused. The API returns a generic identity-conflict response.

If the email already exists without this exact provider link, registration
refuses rather than silently adopting or linking the existing user. This also
prevents treating an internal employee as a customer simply because their
email passes the corporate-domain filter. Existing user type, lifecycle,
profile, permissions and memberships are never changed by registration.

Password self-registration is not offered by the current registration API.
It still requires provider verification; this repair does not introduce an
unverified `PASSWORD` insert or rewrite existing `EMAIL_PASSWORD` requests.
Existing password-method requests and other existing data are preserved.

## Scope and validation

The live-schema test fixture carries the observed issuer-qualified identity
uniqueness, user NOT NULL requirement, allowed identity methods and required
non-password identity link. Tests exercise Google/Microsoft requests, pending
access denial, retries/concurrent submissions, rollback, account/issuer/subject
conflicts, revocation and lifecycle restrictions, and grant validation.

The missing OIDC transaction table must still be created using the standalone
003 repair if it has not already been applied. Provider credentials and
callbacks must be configured independently. Sign-in resolution is documented separately in
[federated identity reconciliation](FEDERATED_IDENTITY_RECONCILIATION.md).
Live provider credentials and redirect configuration still need verification.
