/**
 * Server-side sessions for the GRC platform, stored in the `sessions` table so
 * they can be revoked. The cookie (see auth/session.ts) carries only a signed
 * session id; this module creates, resolves and deletes the row behind it, and
 * resolves the signed-in user's identity and home organisation. Column names
 * follow the hassaudit conventions (documented in grc/docs/schema-assumptions.md).
 */
import type { Client } from '@libsql/client/web';
import { newSessionId, SESSION_MAX_AGE_SECONDS } from '@grc/auth/session';

export interface SessionIdentity {
  userId: string;
  roleCode: string;
  isPlatformOwner: boolean;
  homeOrganizationId: string;
  homeOrganizationName: string;
  userName?: string;
  userEmail?: string;
}

/** Create a session row for a user and return its id. Expiry mirrors the cookie. */
export async function createSession(db: Client, userId: string): Promise<string> {
  const sessionId = newSessionId();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO sessions (session_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    args: [sessionId, userId, createdAt, expiresAt],
  });
  return sessionId;
}

/** Delete a session row, on sign-out. */
export async function deleteSession(db: Client, sessionId: string): Promise<void> {
  await db.execute({ sql: `DELETE FROM sessions WHERE session_id = ?`, args: [sessionId] });
}

/**
 * Resolve a session id to the signed-in user's identity and home organisation,
 * or null when the session is missing, expired, or the user or organisation is
 * inactive. The is_platform_owner flag is read defensively so a database without
 * the column simply yields an ordinary user.
 */
export async function resolveSession(
  db: Client,
  sessionId: string,
): Promise<SessionIdentity | null> {
  const res = await db.execute({
    sql: `SELECT s.expires_at AS expires_at,
                 u.user_id AS user_id, u.full_name AS full_name, u.email AS email,
                 u.role_code AS role_code, u.is_platform_owner AS is_platform_owner,
                 o.organization_id AS organization_id, o.name AS org_name
            FROM sessions s
            JOIN users u ON u.user_id = s.user_id
            JOIN organizations o ON o.organization_id = u.organization_id
           WHERE s.session_id = ?
           LIMIT 1`,
    args: [sessionId],
  });
  const row = res.rows[0];
  if (!row) return null;

  const expiresAt = String(row.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;

  return {
    userId: String(row.user_id),
    roleCode: String(row.role_code),
    isPlatformOwner: Number(row.is_platform_owner ?? 0) === 1,
    homeOrganizationId: String(row.organization_id),
    homeOrganizationName: String(row.org_name),
    userName: row.full_name == null ? undefined : String(row.full_name),
    userEmail: row.email == null ? undefined : String(row.email),
  };
}
