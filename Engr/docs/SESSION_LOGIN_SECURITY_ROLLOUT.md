# Session and login security rollout

Migration `005` must be applied before deploying the Worker code. The new Worker rejects legacy JWT-only cookies and requires the `auth_sessions` table on every authenticated request.

## 1. Check production

In Turso Web, run `db/turso-web/07_check_session_login_security.sql`. A database still on migration 004 lists three missing tables and six missing triggers. The second result should contain no `005` row.

## 2. Apply migration 005

Run `db/turso-web/08_apply_session_login_security.sql` as one Drizzle Studio batch. Do not add `BEGIN`, `COMMIT`, `END`, or `ROLLBACK`; Studio supplies its own transaction.

Run the check script again. It should return no missing objects and exactly one migration row for `005`.

## 3. Deploy and verify

Deploy the Worker after the database succeeds. Existing JWT-only cookies will be cleared, so users sign in once again. Verify:

1. A normal account can sign in and sign out.
2. An owner or administrator completes MFA, then reaches the application.
3. Suspending that user, resetting their password, changing their roles, or changing role permissions ends all existing sessions immediately.
4. Five failed passwords produce a one-minute block. Further failures increase the block up to 30 minutes. A successful login clears the account and IP counters.
5. New passwords are at least 12 characters, are checked through the Have I Been Pwned k-anonymity API, and legacy 60,000-iteration hashes upgrade to 600,000 iterations after a successful login.

No new Cloudflare binding or secret is required. Login limits and session records are stored in Turso. The Worker needs outbound HTTPS access to `api.pwnedpasswords.com` when a password is created or changed.

## Session lifetimes

- Restricted password/MFA sessions: 10-minute absolute and idle lifetime.
- Platform owners and administrators: 2-hour absolute lifetime and 15-minute idle lifetime.
- Standard users: 12-hour absolute lifetime and 2-hour idle lifetime.

Session creation, logout/revocation reason, login success/failure/blocking, and password rehashing are recorded without passwords or raw account/IP values in the login-control tables and audit log.
