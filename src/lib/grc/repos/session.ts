/**
 * Server-side sessions for the GRC platform, stored in the `sessions` table so
 * they can be revoked. The cookie (see auth/session.ts) carries only a signed
 * session id; this module creates, resolves and deletes the row behind it, and
 * resolves the signed-in user's identity and home organisation. Column names
 * follow the hassaudit conventions (documented in grc/docs/schema-assumptions.md).
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { newSessionId, hashToken, SESSION_MAX_AGE_SECONDS } from '@grc/auth/session';
import { sessionLiveness } from '@grc/auth/sessionRules';

// Column names come from the typed schema layer, so a wrong name fails the build.
const SESS = cols(C.sessions);
const S = cols(C.sessions, 's');
const U = cols(C.users, 'u');
const O = cols(C.organizations, 'o');

export interface SessionIdentity {
  userId: string;
  roleCode: string;
  isPlatformOwner: boolean;
  homeOrganizationId: string;
  homeOrganizationName: string;
  userName?: string;
  userEmail?: string;
  /** True when users.must_change_password is set, forcing the change-password flow. */
  mustChangePassword: boolean;
}

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Create a session row for a user and return its id. The cookie carries the
 * signed id (auth/session.ts); the row stores a hash of that token in
 * `token_hash`, never the raw token. Columns match the hassaudit `sessions`
 * table exactly: session_id, user_id, token_hash, ip, user_agent, created_at,
 * expires_at, last_seen_at. Expiry mirrors the cookie.
 */
export async function createSession(
  db: Client,
  userId: string,
  meta: SessionMeta,
): Promise<string> {
  const sessionId = newSessionId();
  const tokenHash = await hashToken(sessionId);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO sessions
            (${SESS.session_id}, ${SESS.user_id}, ${SESS.token_hash}, ${SESS.ip}, ${SESS.user_agent},
             ${SESS.created_at}, ${SESS.expires_at}, ${SESS.last_seen_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [sessionId, userId, tokenHash, meta.ip, meta.userAgent, createdAt, expiresAt, createdAt],
  });
  return sessionId;
}

/** Delete a session row, on sign-out. */
export async function deleteSession(db: Client, sessionId: string): Promise<void> {
  await db.execute({ sql: `DELETE FROM sessions WHERE ${SESS.session_id} = ?`, args: [sessionId] });
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
    sql: `SELECT ${S.expires_at} AS expires_at, ${S.last_seen_at} AS last_seen_at,
                 ${U.user_id} AS user_id, ${U.full_name} AS full_name, ${U.email} AS email,
                 ${U.role_code} AS role_code, ${U.is_platform_owner} AS is_platform_owner,
                 ${U.must_change_password} AS must_change_password,
                 ${O.organization_id} AS organization_id, ${O.org_name} AS org_name
            FROM sessions s
            JOIN users u ON ${U.user_id} = ${S.user_id}
            JOIN organizations o ON ${O.organization_id} = ${U.organization_id}
           WHERE ${S.session_id} = ?
           LIMIT 1`,
    args: [sessionId],
  });
  const row = res.rows[0];
  if (!row) return null;

  // The absolute expiry and the sliding idle window (sessionRules.ts): a
  // session idle beyond the window dies even though the cookie is still valid,
  // so a stolen cookie is only useful while its session stays active.
  const liveness = sessionLiveness(
    row.expires_at == null ? null : String(row.expires_at),
    row.last_seen_at == null ? null : String(row.last_seen_at),
    Date.now(),
  );
  if (!liveness.alive) return null;
  if (liveness.shouldTouch) {
    // Best-effort activity stamp, throttled by the rules so it is not a write
    // on every request; a failed stamp never fails the request.
    try {
      await db.execute({
        sql: `UPDATE sessions SET ${SESS.last_seen_at} = ? WHERE ${SESS.session_id} = ?`,
        args: [new Date().toISOString(), sessionId],
      });
    } catch (err) {
      console.error('[grc.session] last_seen_at stamp failed', err);
    }
  }

  return {
    userId: String(row.user_id),
    roleCode: String(row.role_code),
    isPlatformOwner: Number(row.is_platform_owner ?? 0) === 1,
    homeOrganizationId: String(row.organization_id),
    homeOrganizationName: String(row.org_name),
    userName: row.full_name == null ? undefined : String(row.full_name),
    userEmail: row.email == null ? undefined : String(row.email),
    mustChangePassword: Number(row.must_change_password ?? 0) === 1,
  };
}
