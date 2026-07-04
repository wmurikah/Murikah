/**
 * Resolve a user by their email for the sign-in flow. Email identifies the user
 * across the platform (no organisation slug is entered); the user is then placed
 * in their home organisation. Returns the stored password hash and the status so
 * the endpoint can verify and reject inactive accounts, all behind one generic
 * failure. Column names follow the hassaudit conventions.
 */
import type { Client } from '@libsql/client/web';

export interface LoginUser {
  userId: string;
  passwordHash: string;
  status: string;
  organizationId: string;
  organizationStatus: string;
  userName?: string;
}

export async function resolveUserByEmail(db: Client, email: string): Promise<LoginUser | null> {
  const res = await db.execute({
    sql: `SELECT u.user_id AS user_id, u.password_hash AS password_hash, u.status AS user_status,
                 u.full_name AS full_name,
                 o.organization_id AS organization_id, o.status AS org_status
            FROM users u
            JOIN organizations o ON o.organization_id = u.organization_id
           WHERE u.email = ?
           LIMIT 1`,
    args: [email],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    passwordHash: row.password_hash == null ? '' : String(row.password_hash),
    status: String(row.user_status ?? ''),
    organizationId: String(row.organization_id),
    organizationStatus: String(row.org_status ?? ''),
    userName: row.full_name == null ? undefined : String(row.full_name),
  };
}
