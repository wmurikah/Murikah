# Forced password-change rollout

Migration 003 adds `users.session_version`. Deploy it before deploying the application code because login and middleware read this column.

## Turso Web

1. Run `db/turso-web/03_check_password_session_version.sql`.
2. If it returns the `session_version` row, run `db/turso-web/04_apply_password_session_version.sql` once. If it returns no rows, stop and inspect `schema_migrations` rather than running `ALTER TABLE` again.
3. Confirm migration history contains `001`, `002`, and `003`.

SQLite/libSQL does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is why the read-only check and one-time alteration are separate scripts.

## Application deployment

After migration 003 is present, deploy the Worker. Test with a non-administrator account:

1. As an administrator, enter a temporary password on the user's edit page and save it.
2. Confirm the audit log contains `users.password.reset` without password material.
3. Sign in as that user with the temporary password. The only available page must be `/change-password`; direct application and API paths must redirect or return `password_change_required`.
4. Confirm the temporary password is required, the replacement must be 12–128 characters and differ from it, and the completed change opens the dashboard.
5. Confirm the audit log contains `users.password.change`, `must_change_password` is `0`, and previously issued sessions can no longer access the application.
