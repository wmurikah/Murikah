/**
 * Hass CMS session cookie.
 *
 * Like GRC, the CMS keeps sessions in the database (the `sessions` table), so a
 * session can be revoked server-side. The cookie carries only an opaque session
 * id, HMAC-signed with CMS_SESSION_SECRET so a forged or guessed id is rejected
 * before any database lookup. The cookie is HttpOnly, host-only (no Domain) and
 * Path=/ on cms.murikah.com, named `cms_session` separately from engr's and grc's
 * cookies, so the three products never share a session. Secure is gated on the
 * caller (off only for http development on cms.localhost).
 *
 * A CMS session may be half-authorised: after the password step, when the role
 * requires MFA, the cookie is set with `mfa=pending` until the TOTP step
 * promotes it. The middleware treats a pending cookie as unauthenticated for
 * every route but the MFA step.
 */

export const CMS_SESSION_COOKIE = 'cms_session';
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

// The secret is 32+ random bytes, base64 encoded; decode to the raw HMAC key.
function keyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh opaque session id (128 bits of randomness, hex). */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sha256 hex of a session token, stored in sessions.token_hash. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether the session has cleared MFA, or is still pending the TOTP step. */
export type MfaState = 'ok' | 'pending';

function cookie(value: string, maxAge: number, secure: boolean): string {
  const secureAttr = secure ? '; Secure' : '';
  return `${CMS_SESSION_COOKIE}=${value}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function readRawCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === CMS_SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface CmsCookie {
  sessionId: string;
  mfa: MfaState;
}

// The signed payload is `${sessionId}.${mfa}`, so the MFA state cannot be tampered
// with client-side; the signature covers both.
function payload(sessionId: string, mfa: MfaState): string {
  return `${sessionId}.${mfa}`;
}

/** The Set-Cookie value carrying a signed session id and its MFA state. */
export async function createSessionCookie(
  sessionId: string,
  mfa: MfaState,
  secret: string,
  secure: boolean,
): Promise<string> {
  const body = payload(sessionId, mfa);
  const sig = await hmac(body, secret);
  return cookie(`${body}.${sig}`, SESSION_MAX_AGE_SECONDS, secure);
}

/** Read the cookie and return the session id and MFA state, only when the signature verifies. */
export async function readSessionCookie(
  request: Request,
  secret: string,
): Promise<CmsCookie | null> {
  const raw = readRawCookie(request);
  if (!raw) return null;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const body = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  const sep = body.indexOf('.');
  if (sep <= 0) return null;
  const sessionId = body.slice(0, sep);
  const mfa = body.slice(sep + 1);
  if (mfa !== 'ok' && mfa !== 'pending') return null;
  return { sessionId, mfa };
}

/** The Set-Cookie value that clears the session; attributes match the set cookie. */
export function clearSession(secure: boolean): string {
  return cookie('', 0, secure);
}
