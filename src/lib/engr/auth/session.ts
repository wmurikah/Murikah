/**
 * Session tokens for Engineering Rhythm.
 *
 * A compact JWT (HS256) signed with ENGR_SESSION_SECRET is the session; there
 * is no sessions table. The permission keys are cached in the token so
 * per-request checks need no database round trip. The token is carried in an
 * HttpOnly cookie scoped to /engr, so it is never sent with marketing requests.
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
  return { sub, org, orgSlug, roles: roles.map(String), perms: perms.map(String) };
}

// Sign the payload and return the token string.
async function sign(payload: SessionPayload, secret: string): Promise<string> {
  return new SignJWT({
    org: payload.org,
    orgSlug: payload.orgSlug,
    roles: payload.roles,
    perms: payload.perms,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(keyFromSecret(secret));
}

// ---- cookie shape -----------------------------------------------------------

function cookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/engr; Max-Age=${maxAge}`;
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

/** Sign a session and return the Set-Cookie value to attach to the response. */
export async function createSession(payload: SessionPayload, secret: string): Promise<string> {
  const token = await sign(payload, secret);
  return cookie(token, MAX_AGE_SECONDS);
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

/** Return the Set-Cookie value that clears the session. */
export function clearSession(): string {
  return cookie('', 0);
}
