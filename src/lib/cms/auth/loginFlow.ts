/**
 * The sign-in flow, and the session guard.
 *
 * Deliberately separate from the endpoint files. The endpoints read
 * `cloudflare:workers` env, which only resolves inside the worker; keeping the
 * logic here means the whole flow can be exercised against a throwaway database
 * in a plain node test, which is the difference between authentication that is
 * asserted and authentication that is proved.
 *
 * The one rule that shapes everything below: the browser learns only that
 * sign-in failed. Unknown email, wrong password, inactive user, unverified
 * email, missing credential, an unsupported stored algorithm and a locked
 * account all return the same body and the same status. The real reason goes to
 * `login_attempts.failure_reason` and to `audit_events`, where an administrator
 * can see it and an attacker cannot.
 */
import type { Client } from '@libsql/client/web';
import { verifyPassword, dummyVerify } from './password.ts';
import {
  newSessionToken,
  hashSessionToken,
  sessionWindow,
  toDbTimestamp,
  isExpired,
  SESSION_TTL_SECONDS,
} from './session.ts';
import {
  findCredentialByEmail,
  findSessionByHash,
  markSessionExpired,
  newId,
  loginAttemptStmt,
  auditEventStmt,
  failedAttemptStmt,
  clearAttemptsStmt,
  touchLastLoginStmt,
  createSessionStmt,
  revokeSessionStmt,
  type Stmt,
} from '../repos/authRecords.ts';
import { loadIdentity, type CmsIdentity } from '../repos/identity.ts';

/**
 * Five failures locks the account for fifteen minutes.
 *
 * Five is above the number of times a person mistypes a password they know and
 * far below the number an online guessing attack needs. Fifteen minutes is long
 * enough to make automated guessing pointless (five tries per quarter hour) and
 * short enough that a locked-out user is not calling the service desk, which is
 * what makes an aggressive lockout policy get switched off in practice.
 *
 * This is deliberately not a permanent lock: a permanent one turns a guessing
 * attack into a denial-of-service against a named user, since anyone who knows
 * an email address can lock its owner out indefinitely.
 */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

/** Internal reasons. Recorded, never returned. */
export type LoginFailureReason =
  | 'UNKNOWN_EMAIL'
  | 'INVALID_PASSWORD'
  | 'ACCOUNT_LOCKED'
  | 'USER_NOT_ACTIVE'
  | 'EMAIL_NOT_VERIFIED'
  | 'NO_CREDENTIAL'
  | 'UNSUPPORTED_ALGORITHM'
  | 'MALFORMED_HASH';

export type LoginOutcome =
  | {
      readonly kind: 'success';
      readonly identity: CmsIdentity;
      readonly rawToken: string;
      readonly maxAge: number;
      readonly mustChangePassword: boolean;
    }
  | { readonly kind: 'failure'; readonly reason: LoginFailureReason };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  now: Date;
}

/**
 * The bookkeeping every failure performs, in one place and in ONE round trip.
 *
 * `extra` carries the failed-attempt counter update when there is a credential
 * to count against. Batching it with the attempt row and the audit event is
 * what keeps the account-exists path and the unknown-address path the same
 * cost: without it, the extra write made a known account measurably slower to
 * refuse, which discloses whether an address is registered however identical
 * the response body is.
 */
async function failWith(
  db: Client,
  reason: LoginFailureReason,
  email: string,
  userId: string | null,
  ctx: RequestContext,
  extra: Stmt[] = [],
): Promise<LoginOutcome> {
  await db.batch(
    [
      ...extra,
      loginAttemptStmt({
        email,
        userId,
        success: false,
        failureReason: reason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
      auditEventStmt({
        actorUserId: userId,
        eventType: 'LOGIN_FAILED',
        entityType: 'users',
        // entity_id is NOT NULL, so an unknown email records the attempted
        // address rather than a fabricated id. It is the only identifier there is.
        entityId: userId ?? email,
        action: 'LOGIN',
        afterJson: JSON.stringify({ reason }),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
    ],
    'write',
  );
  return { kind: 'failure', reason };
}

/**
 * Attempt a sign-in.
 *
 * Never throws for a credential problem: a caller gets an outcome and turns it
 * into one generic response.
 */
export async function attemptLogin(
  db: Client,
  secret: string,
  input: { email: string; password: string },
  ctx: RequestContext,
): Promise<LoginOutcome> {
  const record = await findCredentialByEmail(db, input.email);

  // Unknown email. Burn a PBKDF2 derivation of the same cost as a real check
  // before answering, so response time does not disclose whether the address is
  // registered. Identical bodies are not enough on their own: a timing gap is
  // an enumeration oracle that no amount of response shaping closes.
  if (!record) {
    await dummyVerify();
    return failWith(db, 'UNKNOWN_EMAIL', input.email, null, ctx);
  }

  if (record.status !== 'ACTIVE') {
    await dummyVerify();
    return failWith(db, 'USER_NOT_ACTIVE', input.email, record.userId, ctx);
  }
  // The schema's CHECK already guarantees an ACTIVE user is verified. Checked
  // anyway, because a constraint is a statement about the data and this is a
  // statement about the decision, and the two should not be the same line.
  if (!record.emailVerifiedAt) {
    await dummyVerify();
    return failWith(db, 'EMAIL_NOT_VERIFIED', input.email, record.userId, ctx);
  }
  if (!record.credentialId || !record.passwordHash || !record.passwordAlgorithm) {
    await dummyVerify();
    return failWith(db, 'NO_CREDENTIAL', input.email, record.userId, ctx);
  }

  // A live lock short-circuits before any verification. Checking the password
  // of a locked account would let an attacker keep testing guesses through the
  // lock and learn the answer from the timing.
  if (record.lockedUntil && record.lockedUntil > toDbTimestamp(ctx.now)) {
    await dummyVerify();
    return failWith(db, 'ACCOUNT_LOCKED', input.email, record.userId, ctx);
  }

  const verdict = await verifyPassword(
    input.password,
    record.passwordHash,
    record.passwordAlgorithm,
  );
  if (!verdict.ok) {
    const attemptsAfter = record.failedAttempts + 1;
    const locked = attemptsAfter >= LOCKOUT_THRESHOLD;
    const lockedUntil = locked
      ? toDbTimestamp(new Date(ctx.now.getTime() + LOCKOUT_MINUTES * 60_000))
      : null;
    const reason: LoginFailureReason =
      verdict.reason === 'unsupported_algorithm'
        ? 'UNSUPPORTED_ALGORITHM'
        : verdict.reason === 'malformed_hash'
          ? 'MALFORMED_HASH'
          : 'INVALID_PASSWORD';
    return failWith(db, reason, input.email, record.userId, ctx, [
      failedAttemptStmt(record.credentialId, attemptsAfter, lockedUntil, ctx.now),
    ]);
  }

  // The password was correct. Everything from here is the success path.
  const identity = await loadIdentity(db, record.userId);
  if (!identity) {
    // The user passed the state checks a moment ago, so this is a race with a
    // concurrent deactivation rather than a normal outcome. Fail closed.
    return failWith(db, 'USER_NOT_ACTIVE', input.email, record.userId, ctx, [
      clearAttemptsStmt(record.credentialId, ctx.now),
    ]);
  }

  const rawToken = newSessionToken();
  const tokenHash = await hashSessionToken(rawToken, secret);
  const window = sessionWindow(ctx.now, SESSION_TTL_SECONDS);
  const sessionId = newId('ASESS');

  // The session, the counters and the trail go out together. A login that
  // created a session but failed to clear the lock, or recorded no audit event,
  // would be worse than a login that failed outright.
  await db.batch(
    [
      createSessionStmt({
        sessionId,
        userId: record.userId,
        tokenHash,
        issuedAt: window.issuedAt,
        expiresAt: window.expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }),
      touchLastLoginStmt(record.userId, ctx.now),
      clearAttemptsStmt(record.credentialId, ctx.now),
      loginAttemptStmt({
        email: input.email,
        userId: record.userId,
        success: true,
        failureReason: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
      auditEventStmt({
        actorUserId: record.userId,
        eventType: 'LOGIN_SUCCESS',
        entityType: 'auth_sessions',
        entityId: sessionId,
        action: 'LOGIN',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
    ],
    'write',
  );

  return {
    kind: 'success',
    identity,
    rawToken,
    maxAge: window.maxAge,
    mustChangePassword: record.mustChangePassword,
  };
}

/**
 * Why a request is anonymous.
 *
 * The distinction earns its keep at exactly one place: a session that existed
 * and has run out deserves "your session has expired, sign in again", and a
 * request that never carried a cookie deserves silence. Collapsing the two
 * would either nag every first-time visitor or tell a returning user nothing.
 */
export type AnonymousReason = 'no_cookie' | 'unknown_token' | 'expired' | 'revoked' | 'no_user';

export type SessionResolution =
  | { readonly kind: 'authenticated'; readonly sessionId: string; readonly identity: CmsIdentity }
  | { readonly kind: 'anonymous'; readonly reason: AnonymousReason };

/**
 * Resolve a presented cookie to a principal.
 *
 * Used by the middleware guard and by `/api/auth/me`. Expires lazily: a session
 * past `expires_at` is marked EXPIRED on the way past, so the row reflects
 * reality without a sweeper job, and the request is treated as unauthenticated.
 *
 * No authorisation happens here beyond confirming the user is still ACTIVE.
 * The resolved roles and permissions are returned for a later phase to gate on.
 */
export async function resolveSession(
  db: Client,
  secret: string,
  rawToken: string | null,
  now: Date,
): Promise<SessionResolution> {
  if (!rawToken) return { kind: 'anonymous', reason: 'no_cookie' };

  const tokenHash = await hashSessionToken(rawToken, secret);
  const session = await findSessionByHash(db, tokenHash);
  // No row for this hash: a forged cookie, or one signed with another secret.
  if (!session) return { kind: 'anonymous', reason: 'unknown_token' };

  if (session.status === 'REVOKED') return { kind: 'anonymous', reason: 'revoked' };
  if (session.status !== 'ACTIVE') return { kind: 'anonymous', reason: 'expired' };

  if (isExpired(session.expiresAt, now)) {
    await markSessionExpired(db, session.sessionId);
    return { kind: 'anonymous', reason: 'expired' };
  }

  const identity = await loadIdentity(db, session.userId);
  // The session is live but the user is gone or no longer ACTIVE, so a
  // deactivation takes effect on the next request rather than at expiry.
  if (!identity) return { kind: 'anonymous', reason: 'no_user' };

  return { kind: 'authenticated', sessionId: session.sessionId, identity };
}

/** Revoke the presented session, if it resolves to one. Idempotent. */
export async function endSession(
  db: Client,
  secret: string,
  rawToken: string | null,
  ctx: RequestContext,
): Promise<{ revoked: boolean }> {
  if (!rawToken) return { revoked: false };
  const tokenHash = await hashSessionToken(rawToken, secret);
  const session = await findSessionByHash(db, tokenHash);
  if (!session || session.status !== 'ACTIVE') return { revoked: false };

  await db.batch(
    [
      revokeSessionStmt(session.sessionId, ctx.now),
      auditEventStmt({
        actorUserId: session.userId,
        eventType: 'LOGOUT',
        entityType: 'auth_sessions',
        entityId: session.sessionId,
        action: 'LOGOUT',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        now: ctx.now,
      }),
    ],
    'write',
  );
  return { revoked: true };
}
