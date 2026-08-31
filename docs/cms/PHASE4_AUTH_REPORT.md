# Phase 4 authentication report

- **Starting commit:** `532e26441855f0e464cfa17e1ff4fad52ab7249d`
- **Ending implementation commit:** `d2056e5`

## Result

The existing password and CMS session architecture remains in place. Phase 4 adds an identity-first gateway, password recovery, centralized corporate-domain policy, Google/Microsoft/Apple OIDC architecture, provider-subject identity links, and pending customer-access requests. The schema delta is additive and documented in `PHASE4_AUTH_ARCHITECTURE.md`.

## Routes

Pages: `/login`, `/forgot-password`, `/reset-password`, `/register`.
APIs: `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/register`, and provider start/callback routes under `/api/auth/oidc/[provider]`.

## Security and policy

Hass internal identities are never self-created. Consumer email is refused server-side. A registration request creates no user, account or membership. Provider subject—not email—is the unique provider identity. OIDC validates state, nonce, PKCE, signature, issuer, audience and expiry. Password reset stores only a keyed token hash, is single-use, expires, audits completion and revokes active sessions.

## Validation state

- **Implemented:** password reset, registration request gate, OIDC protocol and session integration, identity-first UX.
- **Tested with local/mocked infrastructure:** policy, token hashing, password reset and existing regression suite.
- **Tested against live provider:** NO. Provider consoles and credentials are pending in `Pending.MD`.
- **Customer approval mutation:** intentionally pending a business/security decision; no tenant access is granted meanwhile.

## Integrity ledger

- FRONTEND STACK CHANGED: NO
- CLOUDFLARE RUNTIME CHANGED: NO
- DATABASE TECHNOLOGY CHANGED: NO
- TURSO ACCESS ARCHITECTURE CHANGED: NO
- RBAC ARCHITECTURE CHANGED: NO
- WORKFLOW LOGIC CHANGED: NO
- SLA LOGIC CHANGED: NO
- CRM LOGIC CHANGED: NO
- SERVICE LOGIC CHANGED: NO
- SO/PO LOGIC CHANGED: NO
- ANALYTICS DEFINITIONS CHANGED: NO
- PORTAL TENANT ISOLATION CHANGED: NO
- AUTHENTICATION CAPABILITY CHANGED: YES — intentional Phase 4 scope.

## Phase 4.1 — auth-entry experience

The login and customer-registration pages now share the responsive CMS auth composition. Login presents Microsoft, Google and Apple sign-in before the existing email/password path; registration presents Microsoft and Google only, because Apple remains ineligible to establish the first corporate customer identity. Forgot-password remains visible from login and continues to use the generic, non-enumerating recovery flow.

The broken registration entry was a route-policy defect rather than an anchor defect: `/register`, `/forgot-password` and `/reset-password` existed, but the middleware's default-deny public-page list contained only `/login`. Anonymous navigation was therefore redirected back to login. Those three pages are now explicitly public, while authenticated visitors are redirected to their existing internal or portal home.

A decorative inline-SVG assistant reacts to email attention, typing, password privacy, validation, waiting and completion. It is hidden from assistive technology, uses only namespaced CMS tokens, adds no dependency, and retains state changes without transitions under reduced motion. Password and provider authentication still terminate in the existing `auth_sessions` path.

Live provider validation remains dependent on the Microsoft, Google and Apple Worker-secret configuration described below; unavailable providers return to the correct login or registration entry with a stable error message.
