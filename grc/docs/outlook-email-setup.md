# Outlook email setup (Microsoft Graph)

The GRC platform sends every notification email as the personal Outlook
account `hassaudit@outlook.com`, through Microsoft Graph with a one-time
delegated sign-in. The operator registers the Entra app and sets the secrets;
an admin then connects the mailbox once on Setup, Settings, Email. No secret
is ever committed to the repository.

## 1. Register the Entra app

In the [Microsoft Entra admin centre](https://entra.microsoft.com), App
registrations, New registration:

- Name: anything recognisable, for example `GRC Mail Sender`.
- Supported account types: choose an option that includes **personal
  Microsoft accounts** (the sign-in runs against the `/consumers` authority).
- Redirect URI: platform **Web**, value exactly
  `https://grc.murikah.com/api/admin/outlook/callback`.

Then, under Certificates and secrets, create a **client secret** and copy its
value immediately (it is shown once).

No API permissions need admin consent: the connect flow requests the
delegated scopes `offline_access Mail.Send openid email User.Read` and the
mailbox owner consents at sign-in.

## 2. Set the Worker secrets

```sh
wrangler secret put GRAPH_CLIENT_ID      # the app registration's Application (client) ID
wrangler secret put GRAPH_CLIENT_SECRET  # the client secret value from step 1
wrangler secret put GRC_MAIL_SENDER      # hassaudit@outlook.com
```

Locally these go in `.dev.vars` instead. Two optional values:

- `GRC_ENV` must be exactly `production` for the queue dispatcher to send
  real email; anywhere else the queue drains as a dry-run and rows stay
  PENDING. The test-email button on the Email screen works regardless, so a
  preview can still verify the connection.
- `GRAPH_REFRESH_TOKEN` may seed a refresh token minted elsewhere; it is only
  used until the connect flow (or the first send) stores a rotated token in
  the database, so the normal path is simply to skip it and connect through
  the screen.

## 3. Connect the mailbox

Sign in to the GRC app as an administrator, open Setup, Settings, Email, and
choose **Connect Outlook**. Sign in as `hassaudit@outlook.com` and accept the
consent prompt. The screen then shows "Connected as hassaudit@outlook.com";
use **Send test email** to prove the connection end to end.

What is stored: only a refresh token, sealed with AES-GCM keyed off
`GRC_SESSION_SECRET`, in a platform-wide config row. The token never appears
in a page or a log. Microsoft rotates consumer refresh tokens on every use
and the sender writes the rotated token back, so the connection outlives the
90-day life of any single token as long as mail flows occasionally.

## 4. When the connection lapses

If Microsoft refuses the saved sign-in (password change, consent revoked,
long inactivity), the sender marks the connection stale, logs it under
`[grc.mail]`, and the Email screen shows "Not connected" with the reason.
Queued notifications are held PENDING, never dead-lettered by a lapsed
connection, and resume on the next cron run after an admin reconnects.
