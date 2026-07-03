/**
 * Session tokens for Engineering Rhythm.
 *
 * A compact JWT (HS256) signed with ENGR_SESSION_SECRET is the session; there
 * is no sessions table. The permission keys are cached in the token so
 * per-request checks need no database round trip. The token is carried in an
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

export interface SessionPayload {
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
    sub,
    org,
    orgSlug,
    roles: roles.map(String),
    perms: perms.map(String),
    orgName: optional(claims.orgName),
    userName: optional(claims.userName),
    userEmail: optional(claims.userEmail),
    isPlatformOwner: claims.isPlatformOwner === true,
  };
}

// Sign the payload and return the token string.
async function sign(payload: SessionPayload, secret: string): Promise<string> {
  return new SignJWT({
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
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
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
  return cookie(token, MAX_AGE_SECONDS, secure);
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
