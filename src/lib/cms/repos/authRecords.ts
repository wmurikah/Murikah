/**
 * Reads and writes against the authentication tables.
 *
 * Every statement is parameterised. No SQL in this product is assembled by
 * string concatenation, so a value can never become syntax.
 *
 * Ids follow the schema's own convention: TEXT primary keys with a short
 * prefix, as the seed data uses (USR-, CRED-, ASESS-, LAT-). New rows get a
 * prefix plus a random suffix rather than a sequence, because the worker has no
 * safe way to hold a counter across isolates.
 */
import type { Client } from '@libsql/client/web';
import { toDbTimestamp } from '../auth/session.ts';

/** A prefixed, collision-resistant id. 16 random bytes as hex. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}

/** The user and credential a sign-in attempt needs, in one round trip. */
export interface CredentialRecord {
  userId: string;
  email: string;
  status: string;
  emailVerifiedAt: string | null;
  userType: string;
  /** Null when the user exists but has no auth_credentials row. */
  credentialId: string | null;
  passwordHash: string | null;
  passwordAlgorithm: string | null;
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
}

/**
 * Find a user and their credential by email.
 *
 * A LEFT JOIN rather than two queries, so "no such user" and "user without a
 * credential" are distinguishable in one read. `users.email` is COLLATE NOCASE,
 * so the comparison is case-insensitive in the database; the caller normalises
 * as well, so the recorded attempt and the lookup always agree.
 */
export async function findCredentialByEmail(
  db: Client,
  email: string,
): Promise<CredentialRecord | null> {
  const result = await db.execute({
    sql: `
      SELECT u.user_id, u.email, u.status, u.email_verified_at, u.user_type,
             c.credential_id, c.password_hash, c.password_algorithm,
             c.must_change_password, c.failed_attempts, c.locked_until
      FROM users u
      LEFT JOIN auth_credentials c ON c.user_id = u.user_id
      WHERE u.email = ?
      LIMIT 1`,
    args: [email],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    email: String(row.email),
    status: String(row.status),
    emailVerifiedAt: row.email_verified_at === null ? null : String(row.email_verified_at),
    userType: String(row.user_type),
    credentialId: row.credential_id === null ? null : String(row.credential_id),
    passwordHash: row.password_hash === null ? null : String(row.password_hash),
    passwordAlgorithm: row.password_algorithm === null ? null : String(row.password_algorithm),
    mustChangePassword: Number(row.must_change_password ?? 0) === 1,
    failedAttempts: Number(row.failed_attempts ?? 0),
    lockedUntil: row.locked_until === null ? null : String(row.locked_until),
  };
}

/** A parameterised statement, in the shape the libSQL client takes. */
export interface Stmt {
  sql: string;
  args: (string | number | null)[];
}

/**
 * The statement builders below exist so several writes can go out in ONE
 * database round trip via `batch(..., 'write')`.
 *
 * That is not only a performance point. It closes a timing side channel: the
 * failure path for a known account performs one more write (the failed-attempt
 * counter) than the path for an unknown address, and issuing those writes
 * separately made the account-exists case measurably slower, which is an
 * enumeration oracle no matter how identical the response bodies are. Batched,
 * both paths cost exactly one round trip. It also makes the bookkeeping atomic:
 * an attempt row without its audit event is no longer possible.
 */
export function loginAttemptStmt(input: {
  email: string;
  userId: string | null;
  success: boolean;
  failureReason: string | null;
  ip: string | null;
  userAgent: string | null;
  now: Date;
}): Stmt {
  return {
    sql: `INSERT INTO login_attempts
            (login_attempt_id, email_attempted, user_id, success, failure_reason,
             ip_address, user_agent, attempted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('LAT'),
      input.email,
      input.userId,
      input.success ? 1 : 0,
      input.failureReason,
      input.ip,
      input.userAgent,
      toDbTimestamp(input.now),
    ],
  };
}

export function auditEventStmt(input: {
  actorUserId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson?: string | null;
  afterJson?: string | null;
  ip: string | null;
  userAgent: string | null;
  now: Date;
}): Stmt {
  return {
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('AEV'),
      input.actorUserId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.action,
      input.beforeJson ?? null,
      input.afterJson ?? null,
      input.ip,
      input.userAgent,
      toDbTimestamp(input.now),
    ],
  };
}

/** One more strike, and a lock once the threshold is met. */
export function failedAttemptStmt(
  credentialId: string,
  attemptsAfter: number,
  lockedUntil: string | null,
  now: Date,
): Stmt {
  return {
    sql: `UPDATE auth_credentials
          SET failed_attempts = ?, locked_until = ?, updated_at = ?
          WHERE credential_id = ?`,
    args: [attemptsAfter, lockedUntil, toDbTimestamp(now), credentialId],
  };
}

/** The counter and the lock both clear on a success. */
export function clearAttemptsStmt(credentialId: string, now: Date): Stmt {
  return {
    sql: `UPDATE auth_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE credential_id = ?`,
    args: [toDbTimestamp(now), credentialId],
  };
}

export function touchLastLoginStmt(userId: string, now: Date): Stmt {
  const stamp = toDbTimestamp(now);
  return {
    sql: `UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?`,
    args: [stamp, stamp, userId],
  };
}

export function createSessionStmt(input: {
  sessionId: string;
  userId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}): Stmt {
  return {
    sql: `INSERT INTO auth_sessions
            (session_id, user_id, refresh_token_hash, device_label, ip_address, user_agent,
             issued_at, expires_at, revoked_at, status)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'ACTIVE')`,
    args: [
      input.sessionId,
      input.userId,
      input.tokenHash,
      input.ip,
      input.userAgent,
      input.issuedAt,
      input.expiresAt,
    ],
  };
}

export function revokeSessionStmt(sessionId: string, now: Date): Stmt {
  return {
    sql: `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = ? WHERE session_id = ?`,
    args: [toDbTimestamp(now), sessionId],
  };
}

/** Record a sign-in attempt. Written for a success and for every failure. */
export async function recordLoginAttempt(
  db: Client,
  input: {
    email: string;
    userId: string | null;
    success: boolean;
    failureReason: string | null;
    ip: string | null;
    userAgent: string | null;
    now: Date;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO login_attempts
            (login_attempt_id, email_attempted, user_id, success, failure_reason,
             ip_address, user_agent, attempted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('LAT'),
      input.email,
      input.userId,
      input.success ? 1 : 0,
      input.failureReason,
      input.ip,
      input.userAgent,
      toDbTimestamp(input.now),
    ],
  });
}

/**
 * Write an audit event.
 *
 * `before_json` and `after_json` are caller-supplied and are never given a
 * password, token, hash or MFA secret anywhere in this product. The audit trail
 * records that something happened and to what, never the secret involved.
 */
export async function recordAuditEvent(
  db: Client,
  input: {
    actorUserId: string | null;
    eventType: string;
    entityType: string;
    entityId: string;
    action: string;
    beforeJson?: string | null;
    afterJson?: string | null;
    ip: string | null;
    userAgent: string | null;
    now: Date;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_events
            (audit_event_id, actor_user_id, event_type, entity_type, entity_id, action,
             before_json, after_json, ip_address, user_agent, event_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('AEV'),
      input.actorUserId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.action,
      input.beforeJson ?? null,
      input.afterJson ?? null,
      input.ip,
      input.userAgent,
      toDbTimestamp(input.now),
    ],
  });
}

/** Failure bookkeeping: one more strike, and a lock once the threshold is met. */
export async function registerFailedAttempt(
  db: Client,
  credentialId: string,
  attemptsAfter: number,
  lockedUntil: string | null,
  now: Date,
): Promise<void> {
  await db.execute({
    sql: `UPDATE auth_credentials
          SET failed_attempts = ?, locked_until = ?, updated_at = ?
          WHERE credential_id = ?`,
    args: [attemptsAfter, lockedUntil, toDbTimestamp(now), credentialId],
  });
}

/** Success bookkeeping: the counter and the lock both clear. */
export async function clearFailedAttempts(
  db: Client,
  credentialId: string,
  now: Date,
): Promise<void> {
  await db.execute({
    sql: `UPDATE auth_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE credential_id = ?`,
    args: [toDbTimestamp(now), credentialId],
  });
}

export async function touchLastLogin(db: Client, userId: string, now: Date): Promise<void> {
  const stamp = toDbTimestamp(now);
  await db.execute({
    sql: `UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?`,
    args: [stamp, stamp, userId],
  });
}

/** Create a session row. Only the HMAC of the token is stored, never the token. */
export async function createSession(
  db: Client,
  input: {
    userId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<string> {
  const sessionId = newId('ASESS');
  await db.execute({
    sql: `INSERT INTO auth_sessions
            (session_id, user_id, refresh_token_hash, device_label, ip_address, user_agent,
             issued_at, expires_at, revoked_at, status)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'ACTIVE')`,
    args: [
      sessionId,
      input.userId,
      input.tokenHash,
      input.ip,
      input.userAgent,
      input.issuedAt,
      input.expiresAt,
    ],
  });
  return sessionId;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  status: string;
  expiresAt: string;
}

/**
 * Find a session by the HMAC of the presented cookie.
 *
 * One indexed equality match on the UNIQUE `refresh_token_hash`. The status is
 * returned rather than filtered in SQL, so the caller can distinguish "expired,
 * mark it" from "revoked, reject it" and act on each.
 */
export async function findSessionByHash(
  db: Client,
  tokenHash: string,
): Promise<SessionRecord | null> {
  const result = await db.execute({
    sql: `SELECT session_id, user_id, status, expires_at
          FROM auth_sessions WHERE refresh_token_hash = ? LIMIT 1`,
    args: [tokenHash],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    status: String(row.status),
    expiresAt: String(row.expires_at),
  };
}

/** Lazy expiry: a session found past its expires_at is marked, then rejected. */
export async function markSessionExpired(db: Client, sessionId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE auth_sessions SET status = 'EXPIRED' WHERE session_id = ? AND status = 'ACTIVE'`,
    args: [sessionId],
  });
}

export async function revokeSession(db: Client, sessionId: string, now: Date): Promise<void> {
  await db.execute({
    sql: `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = ? WHERE session_id = ?`,
    args: [toDbTimestamp(now), sessionId],
  });
}

/** Upsert the single credential row for a user. Used only by the bootstrap. */
export async function upsertCredential(
  db: Client,
  input: {
    userId: string;
    passwordHash: string;
    algorithm: string;
    mustChangePassword: boolean;
    now: Date;
  },
): Promise<'inserted' | 'updated'> {
  const stamp = toDbTimestamp(input.now);
  // auth_credentials.user_id is UNIQUE, so there is exactly one row per user and
  // the update either hits it or hits nothing.
  const updated = await db.execute({
    sql: `UPDATE auth_credentials
          SET password_hash = ?, password_algorithm = ?, must_change_password = ?,
              password_changed_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE user_id = ?`,
    args: [
      input.passwordHash,
      input.algorithm,
      input.mustChangePassword ? 1 : 0,
      stamp,
      stamp,
      input.userId,
    ],
  });
  if (Number(updated.rowsAffected ?? 0) > 0) return 'updated';

  await db.execute({
    sql: `INSERT INTO auth_credentials
            (credential_id, user_id, password_hash, password_algorithm, must_change_password,
             password_changed_at, failed_attempts, locked_until, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    args: [
      newId('CRED'),
      input.userId,
      input.passwordHash,
      input.algorithm,
      input.mustChangePassword ? 1 : 0,
      stamp,
      stamp,
      stamp,
    ],
  });
  return 'inserted';
}
