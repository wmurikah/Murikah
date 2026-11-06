# Invitation, recovery and authenticator MFA rollout

Deploy the database and Cloudflare secret before the Worker code.

## 1. Turso Web

1. Confirm migrations `001`, `002`, and `003` already exist in `schema_migrations`.
2. Run `db/turso-web/05_check_auth_recovery_mfa.sql`. A database awaiting migration 004 returns the three missing tables.
3. Run `db/turso-web/06_apply_auth_recovery_mfa.sql` once.
4. Confirm migration history now contains `001` through `004`.

## 2. Cloudflare secret

Generate a separate 32-byte AES-GCM key in the browser developer console:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
```

Add the result to the `murikah-engr` Worker's Production variables and secrets as an encrypted secret named `ENGR_MFA_ENCRYPTION_KEY`. Keep it stable: replacing it makes existing authenticator secrets unreadable and requires controlled MFA recovery.

Invitation and recovery mail uses the existing notification dispatcher. Before testing delivery, Production must have `ENGR_ENV=production`, `EMAIL_API_KEY`, and `EMAIL_FROM` configured. If delivery is unavailable, messages remain queued rather than being marked sent.

## 3. Deploy and verify

After the database and secret are ready, deploy the Worker.

- Create a user without a temporary password. Confirm the user is `INVITED`, one unexpired hashed `INVITE` token exists, and an `auth.invitation` email is queued.
- Redeem the link once. Confirm the user becomes `ACTIVE`, the token and every sibling token are consumed, and a second redemption fails.
- Submit the forgot-password form for both known and unknown addresses. Both responses must be identical. For the known address, confirm a one-hour hashed `RESET` token and queued email.
- Sign in as a platform owner or a user with `OWNER`/`ADMIN`. Confirm authenticator enrollment is mandatory, a code must be confirmed before enablement, recovery codes are displayed once, and the QR secret is encrypted in `user_mfa`.
- Confirm a used TOTP time step and a used recovery code cannot be replayed.
- After ten minutes, confirm `/admin/**`, `/api/admin/**`, and organisation switching require another MFA challenge.
