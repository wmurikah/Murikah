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

Apply `cms/db/migrations/001_phase4_identity.sql` to each CMS database before deploying the routes. The migration is SQLite/libSQL-compatible and additive.
