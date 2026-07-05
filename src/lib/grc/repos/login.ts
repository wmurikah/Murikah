/**
 * Resolve an active user by their email for the sign-in flow. Email identifies
 * the user across the platform (no organisation slug is entered); the user is
 * then placed in their home organisation. The query itself requires an active
 * account and organisation, so an inactive user or organisation returns null and
 * the endpoint shows the one generic failure. Column names match the hassaudit
 * schema exactly: `organizations` uses `org_name` and `is_active` (there is no
 * `status` or `name` column on it); the role is `users.role_code` (no join).
 */
import type { Client } from '@libsql/client/web';

export interface LoginUser {
  userId: string;
  passwordHash: string;
  organizationId: string;
  userName?: string;
  /** The user's single role code, for the role-based default landing. */
  roleCode: string;
  isPlatformOwner: boolean;
}

export async function resolveUserByEmail(db: Client, email: string): Promise<LoginUser | null> {
  const res = await db.execute({
    sql: `SELECT u.user_id AS user_id, u.password_hash AS password_hash,
                 u.full_name AS full_name, u.role_code AS role_code,
                 u.is_platform_owner AS is_platform_owner,
                 o.organization_id AS organization_id
            FROM users u
            JOIN organizations o ON o.organization_id = u.organization_id
           WHERE u.email = ?
             AND u.deleted_at IS NULL
             AND u.status = 'ACTIVE'
             AND o.is_active = 1
           LIMIT 1`,
    args: [email],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    passwordHash: row.password_hash == null ? '' : String(row.password_hash),
    organizationId: String(row.organization_id),
    userName: row.full_name == null ? undefined : String(row.full_name),
    roleCode: String(row.role_code ?? ''),
    isPlatformOwner: Number(row.is_platform_owner ?? 0) === 1,
  };
}

/** Record a successful sign-in on users.last_login_at. Best-effort. */
export async function touchLastLogin(db: Client, userId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE users SET last_login_at = ? WHERE user_id = ?`,
    args: [new Date().toISOString(), userId],
  });
}
