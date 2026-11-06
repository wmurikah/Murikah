/**
 * Session tokens for Engineering Rhythm.
 *
 * A compact JWT (HS256) signed with ENGR_SESSION_SECRET identifies a tracked
 * server-side session. The token is carried in an
 * HttpOnly cookie at Path=/ on the app's own host (engr.murikah.com). It is
 * host-only, with no Domain attribute, so it stays confined to that subdomain
 * and never reaches the marketing site or a sibling subdomain. Secure is gated
 * on the caller (off for http development on engr.localhost). When per-tenant
 * subdomains arrive, keep the cookie host-only per subdomain; do not widen it to
 * a shared parent domain.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const SESSION_COOKIE = 'engr_session';
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours
const PRIVILEGED_MAX_AGE_SECONDS = 2 * 60 * 60;
const PASSWORD_CHANGE_MAX_AGE_SECONDS = 10 * 60;

export interface SessionPayload {
  sessionId?: string;
  sub: string; // user id
  org: string; // org id
  orgSlug: string;
  roles: string[]; // role codes
  perms: string[]; // permission keys
  // Display identity, optional so a token minted before these were added still
  // verifies (the holder keeps their session and picks the fields up on next
  // sign-in). The view falls back to the slug when orgName is absent.
  orgName?: string;
  userName?: string;
  userEmail?: string;
  // True for a platform owner (users.is_platform_owner). Only a platform owner
  // may switch the acting organisation; every other user is scoped to their home
  // organisation. Optional and defaults to false on an older token.
  isPlatformOwner?: boolean;
  /** Incremented on every password reset/change. Older tokens stop matching the
   * database immediately, which revokes sessions on every device. */
  sessionVersion?: number;
  /** Restricted authentication after a temporary password is accepted. */
  passwordChangeOnly?: boolean;
  authStage?: 'password-change' | 'mfa-enroll' | 'mfa-challenge';
  /** Unix seconds of the latest successful TOTP/recovery challenge. */
  mfaVerifiedAt?: number;
  /** Shorter absolute lifetime for owners and administrators. */
  privilegedSession?: boolean;
}

export function sessionMaxAge(payload: SessionPayload): number {
  if (payload.passwordChangeOnly || payload.authStage) return PASSWORD_CHANGE_MAX_AGE_SECONDS;
  return payload.privilegedSession ? PRIVILEGED_MAX_AGE_SECONDS : MAX_AGE_SECONDS;
}

// The secret is 32+ random bytes, base64 encoded; decode to the raw HMAC key.
function keyFromSecret(secret: string): Uint8Array {
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toPayload(claims: JWTPayload): SessionPayload | null {
  const sub = claims.sub;
  const org = claims.org;
  const orgSlug = claims.orgSlug;
  const roles = claims.roles;
  const perms = claims.perms;
  if (typeof sub !== 'string' || typeof org !== 'string' || typeof orgSlug !== 'string')
    return null;
  if (!Array.isArray(roles) || !Array.isArray(perms)) return null;
  const optional = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    sessionId: optional(claims.sessionId),
    sub,
    org,
    orgSlug,
    roles: roles.map(String),
    perms: perms.map(String),
    orgName: optional(claims.orgName),
    userName: optional(claims.userName),
    userEmail: optional(claims.userEmail),
    isPlatformOwner: claims.isPlatformOwner === true,
    sessionVersion:
      typeof claims.sessionVersion === 'number' && Number.isInteger(claims.sessionVersion)
        ? claims.sessionVersion
        : 0,
    passwordChangeOnly: claims.passwordChangeOnly === true,
    authStage:
      claims.authStage === 'password-change' ||
      claims.authStage === 'mfa-enroll' ||
      claims.authStage === 'mfa-challenge'
        ? claims.authStage
        : undefined,
    mfaVerifiedAt:
      typeof claims.mfaVerifiedAt === 'number' && Number.isInteger(claims.mfaVerifiedAt)
        ? claims.mfaVerifiedAt
        : undefined,
    privilegedSession: claims.privilegedSession === true,
  };
}

// Sign the payload and return the token string.
async function sign(payload: SessionPayload, secret: string): Promise<string> {
  const maxAge = sessionMaxAge(payload);
  return new SignJWT({
    sessionId: payload.sessionId,
    org: payload.org,
    orgSlug: payload.orgSlug,
    roles: payload.roles,
    perms: payload.perms,
    // Undefined claims are dropped when the token is serialised.
    orgName: payload.orgName,
    userName: payload.userName,
    userEmail: payload.userEmail,
    // Only carried when true, so an ordinary token stays compact.
    isPlatformOwner: payload.isPlatformOwner ? true : undefined,
    sessionVersion: payload.sessionVersion ?? 0,
    passwordChangeOnly: payload.passwordChangeOnly ? true : undefined,
    authStage: payload.authStage,
    mfaVerifiedAt: payload.mfaVerifiedAt,
    privilegedSession: payload.privilegedSession ? true : undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(keyFromSecret(secret));
}

// ---- cookie shape -----------------------------------------------------------

function cookie(value: string, maxAge: number, secure: boolean): string {
  // Host-only (no Domain), Path=/, so it is confined to this subdomain. Secure
  // is off only for http development.
  const secureAttr = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function readCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

// ---- public API -------------------------------------------------------------

/**
 * Sign a session and return the Set-Cookie value to attach to the response. Pass
 * secure=true in production (https); false only for http development.
 */
export async function createSession(
  payload: SessionPayload,
  secret: string,
  secure: boolean,
): Promise<string> {
  const token = await sign(payload, secret);
  const maxAge = sessionMaxAge(payload);
  return cookie(token, maxAge, secure);
}

/** Read and verify the session cookie, returning the payload or null. */
export async function readSession(
  request: Request,
  secret: string,
): Promise<SessionPayload | null> {
  const token = readCookie(request);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFromSecret(secret), { algorithms: ['HS256'] });
    return toPayload(payload);
  } catch {
    return null;
  }
}

/**
 * Return the Set-Cookie value that clears the session. The attributes must match
 * the set cookie (Path=/, host-only, Secure in production) for the browser to
 * remove it.
 */
export function clearSession(secure: boolean): string {
  return cookie('', 0, secure);
}
