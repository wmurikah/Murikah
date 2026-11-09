# Authentication email encryption rollout

Engineering Rhythm stores invitation and password-reset email bodies encrypted while they wait for delivery. This change uses the existing `notifications` and `auth_tokens` tables; **no Turso schema change or SQL script is required**.

## Before deploying the Worker

In Cloudflare, open **Workers & Pages → murikah-engr → Settings → Variables and Secrets → Production**. Add an **encrypted secret** named `ENGR_AUTH_MESSAGE_KEY` containing a new Base64-encoded 32-byte random key. It must be different from `ENGR_MFA_ENCRYPTION_KEY` and `ENGR_SESSION_SECRET`. Generate the value locally with a trusted password manager or, in a browser console, run:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
```

Paste the generated value into Cloudflare's secret field, not a repository file, chat, or Turso. Keep it stable: replacing it while encrypted messages are queued prevents those messages from being sent. Retain a protected backup of the key according to your secret-management process.

Make sure `ENGR_ENV=production`, `EMAIL_API_KEY`, and `EMAIL_FROM` are already configured for real delivery. The new secret is independent of those provider settings.

## Deploy and check

Deploy the Worker after the secret is saved. The public `/api/health` response should report `authMessageEncryption: ready`. If the secret is absent or malformed, new password-reset requests return the same generic confirmation but do not issue a token; new passwordless invitations are rejected; existing encrypted email remains queued. The health endpoint returns 503 so the configuration gap is visible without revealing the key.

On the first scheduled dispatcher run, the Worker redacts old plaintext invitation/reset links and revokes **those exact tokens**. It also redacts encrypted messages whose tokens were used, replaced, or expired. This runs even if external email delivery is disabled. Allow one dispatcher interval after deployment, then confirm no usable links remain in `notifications.body`:

```sql
SELECT COUNT(*) AS legacy_auth_links
FROM notifications
WHERE channel = 'EMAIL'
  AND template_key IN ('auth.invitation', 'auth.password.reset')
  AND body LIKE '%/set-password?token=%';
```

The count must be zero. Do not export full notification bodies while checking. A user whose older reset link was invalidated should use **Forgot password** again. For an older invitation that was invalidated, an administrator can set a temporary password in **Setup → Users**; the user will be required to change it at first sign-in. Newly created invitations use encrypted queue payloads.

Test a new invitation and reset request. Before delivery, `notifications.body` should start with `authenc:v1:` and must not contain `/set-password?token=`. The token table still stores only SHA-256 token hashes. After Resend accepts the message, the queue body becomes `[authentication link removed]`. A provider rejection leaves the encrypted body available for retry while its token is valid; expired, used, or already-sent links cannot be retried. The operations screen shows **New link needed** for failures that cannot safely be retried.

Completing password setup or an administrator password reset revokes the account's remaining reset and invitation tokens and removes their queued payloads in the same database transaction. The scheduled dispatcher also clears expired or superseded payloads, including ones left by an earlier deployment.

Restrict direct Turso access, database exports, and Worker secret administration to platform operators. Application notification pages do not display EMAIL bodies, but encryption protects queued links against a database-only read. Never log decrypted email bodies or the key.
