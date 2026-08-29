# CMS identity provider setup

Register these exact callback paths on the public CMS origin:

- `/api/auth/oidc/google/callback`
- `/api/auth/oidc/microsoft/callback`
- `/api/auth/oidc/apple/callback` (Apple `form_post`)

Set Worker secrets with `wrangler secret put`; never put values in source:

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Microsoft Entra: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT` (defaults to organisational accounts)
- Apple: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
- Reset delivery: `CMS_AUTH_MAIL_ENDPOINT`, `CMS_AUTH_MAIL_SECRET`

Google and Microsoft registration applications must request only OpenID, email and profile claims. Provider email must be verified. Apple is enabled for sign-in/linking, not initial registration. Validate every development, staging and production redirect URI in its provider console. Rotate secrets using Worker secret versions, then test login before retiring the previous value.

## Database sequence

Do **not** blindly apply `001_phase4_identity.sql` to a database that already has the verified live Phase 4 tables. `CREATE TABLE IF NOT EXISTS` does not reconcile column drift.

For the verified live Turso database:

1. Reconfirm the preconditions and row counts in `PHASE4_LIVE_VERIFICATION.sql`.
2. Review and run `PHASE4_LIVE_RECONCILIATION.sql` once. It preserves existing live request rows while rebuilding only the additive request table and adding the OIDC transaction table.
3. Run `PHASE4_LIVE_VERIFICATION.sql` again and require empty foreign-key results plus `ok` integrity.

`001_phase4_identity.sql` remains as immutable migration history. Its application status outside the verified live database is unknown; operators must inventory a database before choosing a migration path.
