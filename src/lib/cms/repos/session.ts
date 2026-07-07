/**
 * Server-side sessions for the Hass CMS, stored in the live `sessions` table so
 * they can be revoked. The cookie (auth/session.ts) carries only a signed session
 * id and MFA state; this module creates, resolves and deletes the row behind it.
 * The session caches user_type and role for fast auth. Note the real column names
 * are ip_address, user_agent and last_activity_at (not the abbreviations some
 * older notes used): they come from the typed schema layer, so the build binds
 * them to the live schema.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';
import { newSessionId, hashToken, SESSION_MAX_AGE_SECONDS } from '@cms/auth/session';
import type { UserType } from './authUsers';

const SESS = cols(C.sessions);
const S = cols(C.sessions, 's');

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
  countryCode: string | null;
}

export interface SessionIdentity {
  userType: UserType;
  userId: string;
  role: string | null;
  countryCode: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** Create a session row for a resolved identity and return its id. */
export async function createSession(
  db: Client,
  identity: { userType: UserType; userId: string; role: string | null },
  meta: SessionMeta,
): Promise<string> {
  const sessionId = newSessionId();
  const tokenHash = await hashToken(sessionId);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO sessions
            (${SESS.session_id}, ${SESS.user_type}, ${SESS.user_id}, ${SESS.token_hash},
             ${SESS.ip_address}, ${SESS.user_agent}, ${SESS.country_code}, ${SESS.role},
             ${SESS.is_active}, ${SESS.expires_at}, ${SESS.last_activity_at}, ${SESS.created_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      sessionId,
      identity.userType,
      identity.userId,
      tokenHash,
      meta.ip,
      meta.userAgent,
      meta.countryCode,
      identity.role,
      expiresAt,
      createdAt,
      createdAt,
    ],
  });
  return sessionId;
}

/**
 * Resolve a session id to its identity, or null when missing, inactive or
 * expired. Touches last_activity_at as a best effort (never fails the request).
 */
export async function resolveSession(
  db: Client,
  sessionId: string,
): Promise<SessionIdentity | null> {
  const res = await db.execute({
    sql: `SELECT ${S.user_type} AS user_type, ${S.user_id} AS user_id, ${S.role} AS role,
                 ${S.country_code} AS country_code, ${S.is_active} AS is_active,
                 ${S.expires_at} AS expires_at
            FROM sessions s WHERE ${S.session_id} = ? LIMIT 1`,
    args: [sessionId],
  });
  const r = res.rows[0];
  if (!r) return null;
  if (Number(r.is_active ?? 0) !== 1) return null;
  const expiresAt = String(r.expires_at ?? '');
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;
  const userType = String(r.user_type) === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';
  return {
    userType,
    userId: String(r.user_id),
    role: s(r.role),
    countryCode: s(r.country_code),
  };
}

/** Best-effort activity touch, so an idle session's last_activity_at stays fresh. */
export async function touchSession(db: Client, sessionId: string): Promise<void> {
  await db
    .execute({
      sql: `UPDATE sessions SET ${SESS.last_activity_at} = ? WHERE ${SESS.session_id} = ?`,
      args: [new Date().toISOString(), sessionId],
    })
    .catch(() => undefined);
}

/** Delete a session row, on sign-out. */
export async function deleteSession(db: Client, sessionId: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM sessions WHERE ${SESS.session_id} = ?`,
    args: [sessionId],
  });
}

export interface DisplayIdentity {
  name: string;
  email: string;
  customerId: string | null;
}

/** The display name and email for a session's user, by type. Null when gone. */
export async function getDisplayIdentity(
  db: Client,
  userType: UserType,
  userId: string,
): Promise<DisplayIdentity | null> {
  if (userType === 'STAFF') {
    const U = cols(C.users);
    const res = await db.execute({
      sql: `SELECT ${U.first_name} AS first_name, ${U.last_name} AS last_name, ${U.email} AS email
              FROM users WHERE ${U.user_id} = ? LIMIT 1`,
      args: [userId],
    });
    const r = res.rows[0];
    if (!r) return null;
    return {
      name: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ') || String(r.email),
      email: String(r.email),
      customerId: null,
    };
  }
  const CT = cols(C.contacts);
  const res = await db.execute({
    sql: `SELECT ${CT.first_name} AS first_name, ${CT.last_name} AS last_name, ${CT.email} AS email,
                 ${CT.customer_id} AS customer_id
            FROM contacts WHERE ${CT.contact_id} = ? LIMIT 1`,
    args: [userId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    name: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ') || String(r.email),
    email: String(r.email),
    customerId: s(r.customer_id),
  };
}
