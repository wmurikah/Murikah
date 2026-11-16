/**
 * GRC session cookie.
 *
 * Unlike Engineering Rhythm's stateless JWT, GRC keeps sessions in the database
 * (the `sessions` table), so a session can be revoked server-side. The cookie
 * carries only an opaque session id, HMAC-signed with GRC_SESSION_SECRET so a
 * forged or guessed id is rejected before any database lookup. The cookie is
 * HttpOnly, host-only (no Domain) and Path=/ on grc.murikah.com, separate from
 * engr's session. Production uses the `__Host-` prefix; development retains the
 * legacy name because `__Host-` requires HTTPS. Secure is gated on the caller
 * (off only for http development on grc.localhost).
 */

export const GRC_SESSION_COOKIE = '__Host-grc_session';
export const GRC_SESSION_COOKIE_LEGACY = 'grc_session';
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

async function hmac(sessionId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId));
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

function cookie(
  value: string,
  maxAge: number,
  secure: boolean,
  name = secure ? GRC_SESSION_COOKIE : GRC_SESSION_COOKIE_LEGACY,
): string {
  const secureAttr = secure ? '; Secure' : '';
  return `${name}=${value}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function readRawCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const values = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    values.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return values.get(GRC_SESSION_COOKIE) ?? values.get(GRC_SESSION_COOKIE_LEGACY) ?? null;
}

/**
 * Whether the session has cleared the second factor. Mirroring the CMS: after
 * the password step, a user with MFA enrolled gets a `pending` cookie that
 * only the TOTP step (or sign-out) accepts; verifying promotes it to `ok`.
 */
export type GrcMfaState = 'ok' | 'pending';

export interface GrcSessionCookie {
  sessionId: string;
  mfa: GrcMfaState;
}

// The signed payload is `${sessionId}.${mfa}` (or the bare id for cookies from
// before the MFA step, which read as `ok`); the signature covers the whole
// payload, so the MFA state cannot be tampered with client-side.
/** The Set-Cookie value carrying a signed session id and its MFA state. */
export async function createSessionCookie(
  sessionId: string,
  secret: string,
  secure: boolean,
  mfa: GrcMfaState = 'ok',
): Promise<string> {
  const body = mfa === 'ok' ? sessionId : `${sessionId}.${mfa}`;
  const sig = await hmac(body, secret);
  return cookie(`${body}.${sig}`, SESSION_MAX_AGE_SECONDS, secure);
}

/** Read the cookie into its session id and MFA state, only when the signature verifies. */
export async function readGrcSessionCookie(
  request: Request,
  secret: string,
): Promise<GrcSessionCookie | null> {
  const raw = readRawCookie(request);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  const sep = body.indexOf('.');
  if (sep <= 0) return { sessionId: body, mfa: 'ok' };
  const mfa = body.slice(sep + 1);
  if (mfa !== 'pending') return null;
  return { sessionId: body.slice(0, sep), mfa };
}

/**
 * Read the cookie and return the session id only when its signature verifies,
 * whatever the MFA state (sign-out and rotation work from a pending session).
 */
export async function readSessionId(request: Request, secret: string): Promise<string | null> {
  const parsed = await readGrcSessionCookie(request, secret);
  return parsed ? parsed.sessionId : null;
}

/** The Set-Cookie value that clears the session; attributes match the set cookie. */
export function clearSession(secure: boolean): string {
  return cookie('', 0, secure);
}

/** Clear both the hardened production name and the pre-migration name. */
export function clearSessionCookies(secure: boolean): string[] {
  if (!secure) return [cookie('', 0, false, GRC_SESSION_COOKIE_LEGACY)];
  return [cookie('', 0, true, GRC_SESSION_COOKIE), cookie('', 0, true, GRC_SESSION_COOKIE_LEGACY)];
}
