# Murikah Tutor SSO / social sign-in

Murikah Tutor uses Google as the primary production single sign-on option while retaining the existing local username/password flow. Microsoft and Apple remain supported optional providers.

The application-side OAuth/OIDC flow is implemented. Google credentials are required for the production Tutor account experience; Microsoft and Apple are optional. Provider credentials live only in the runtime secret store (Cloudflare Workers production secrets, or GitHub Codespaces secrets for development). Never commit them to this repository, Dockerfiles, Tutor data files or shell history.

## Production callback URLs

Use these exact HTTPS redirect / return URLs in the provider consoles:

- Google: `https://tutor.murikah.com/api/auth/oauth/google/callback`
- Microsoft: `https://tutor.murikah.com/api/auth/oauth/microsoft/callback`
- Apple: `https://tutor.murikah.com/api/auth/oauth/apple/callback`

The runtime public base defaults to `https://tutor.murikah.com` and can be overridden with `MURIKAH_PUBLIC_BASE_URL`.

## Google

Create a Google OAuth web client for Murikah Tutor. Configure the production redirect URI exactly as shown above. Use the normal `openid profile email` scopes; no Google API data access is required by Tutor sign-in.

Store the credentials as runtime secrets:

- `MURIKAH_GOOGLE_CLIENT_ID`
- `MURIKAH_GOOGLE_CLIENT_SECRET`

For `tutor.murikah.com`, add both names in the Cloudflare Worker **Variables & Secrets** settings. The Worker already forwards them into the Tutor container; no client secret belongs in Git or `wrangler.toml`. Google is deliberately shown first on the account page whenever these two values are present.

Google may require an OAuth consent screen, verified domain information and production verification depending on the audience and publication state of the OAuth app.

## Microsoft

Create a Microsoft Entra app registration for a server-side Web application and add the production redirect URI above under the Web platform. For broad public sign-in, choose an account type that permits the Microsoft account audiences Murikah intends to support.

Create an application credential and store:

- `MURIKAH_MICROSOFT_CLIENT_ID`
- `MURIKAH_MICROSOFT_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_TENANT` — optional; defaults to `common`

`common` supports the multitenant/personal-account style flow when the Entra app registration is configured for that audience. Use a concrete tenant ID instead if Murikah intentionally wants a tenant-restricted deployment.

## Apple

Apple web sign-in requires more provider-side setup than Google or Microsoft. Create/configure a Sign in with Apple Services ID, associate it with an eligible primary App ID, register `tutor.murikah.com`, configure the exact return URL above, and create a Sign in with Apple private key.

Store:

- `MURIKAH_APPLE_CLIENT_ID` — Services ID / client identifier
- `MURIKAH_APPLE_TEAM_ID`
- `MURIKAH_APPLE_KEY_ID`
- one of:
  - `MURIKAH_APPLE_PRIVATE_KEY`
  - `MURIKAH_APPLE_PRIVATE_KEY_B64` — preferred for multiline `.p8` material in secret stores

Do not expose or commit the `.p8` private key.

## Cloudflare production activation

The production Worker keeps provider credentials in Cloudflare Variables & Secrets. Google is now a required production secret pair, and `RESEND_API_KEY` is required for first-account verification email delivery. Configure the two values above on the `murikah-tutor-container-staging` Worker and keep the redirect URI exactly `https://tutor.murikah.com/api/auth/oauth/google/callback`. The provider-discovery endpoint exposes Google only when both credentials are complete, so a branded button can never lead to an unconfigured provider.

## Codespaces activation

Create the provider credentials as GitHub Codespaces secrets scoped to `wmurikah/Murikah`. `tutor/codespaces/start.sh` and `autostart.sh` forward only provider variables that exist in the outer Codespace environment. Values are not written to Git.

After creating or changing secrets, start a new Codespace session if necessary so GitHub injects them, then recreate the Tutor container once:

```bash
git pull --ff-only origin main
bash tutor/codespaces/start.sh
```

Check readiness without printing any secret values:

```bash
bash tutor/codespaces/sso-status.sh
```

The status command reports each provider as `READY`, `NOT CONFIGURED`, `RESTART NEEDED`, or `RUNNING ONLY`, prints the exact production callbacks, and checks the local `/api/auth/oauth/providers` endpoint when the Tutor container is running.

## Runtime behaviour

`/api/auth/oauth/providers` exposes only providers whose required runtime credentials are complete. The login page therefore renders `Continue with Google`, `Continue with Microsoft` and/or `Continue with Apple` only when that provider is actually configured.

For an already-mapped provider identity, successful provider authentication signs the existing user in normally. For a **new** provider identity, Tutor does not create the member session immediately: it sends a six-digit code to the provider email, opens the Murikah verification step, and creates/maps the account only after that code is confirmed. The challenge expires after 10 minutes and is one-time-use. Existing provider users are not forced through this first-account gate again.

A matching email address alone never auto-links an existing local account. This deliberately prevents an external identity from silently taking over an administrator or other pre-existing local account.

Local self-registration uses an email address rather than a username-only identity. New local accounts use the same email-verification gate before the guest identity is converted into a member. Existing local accounts continue to sign in normally.

## Guest access boundary

Unauthenticated learners receive seven successful model interactions by default. The remaining allowance is not displayed before exhaustion. Guest learning modes use the configured model and learner-facing defaults, but they do not expose or persist authenticated DeepTutor sessions, private knowledge bases, saved memory, workspace state, connected agents, Partners or user settings. Those capabilities remain behind sign-in.
