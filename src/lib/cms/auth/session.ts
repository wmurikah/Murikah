/**
 * Session tokens for the CMS.
 *
 * The raw token goes to the browser in an HttpOnly cookie and nowhere else. The
 * database stores only HMAC-SHA-256(raw token, CMS_SESSION_SECRET) in
 * `auth_sessions.refresh_token_hash`.
 *
 * The HMAC rather than a plain digest is the point. A plain SHA-256 of a
 * 256-bit random token is not realistically reversible either, but the HMAC
 * moves the security from "the token had enough entropy" to "the attacker also
 * needs a secret the database does not contain". Someone holding a stolen
 * database dump can therefore neither read live session tokens nor confirm a
 * guess offline, because every check needs the key that lives only in the
 * worker's environment.
 *
 * `crypto.subtle` and `crypto.getRandomValues` are native in both the Workers
 * runtime and Node 22, so this module works unchanged in the API and in tests.
 */

/** 32 bytes = 256 bits of entropy from the platform CSPRNG. */
const TOKEN_BYTES = 32;

/**
 * URL-safe base64 without padding. The token travels in a cookie value, so it
 * must avoid `=`, `+` and `/`, which are either separators or need escaping.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh session token. Never logged, never stored, never returned in a body. */
export function newSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * The value stored in `auth_sessions.refresh_token_hash`.
 *
 * Deterministic, so a lookup is a single indexed equality match on the UNIQUE
 * column rather than a scan: compute the HMAC of the presented cookie and look
 * for that one row.
 */
export async function hashSessionToken(rawToken: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Session lifetime. Eight hours matches an operational shift: long enough that
 * a dispatcher is not signed out mid-task, short enough that an unattended
 * terminal does not stay usable overnight.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Timestamps in the format this schema uses throughout: TEXT, UTC, second
 * precision, `YYYY-MM-DD HH:MM:SS`, matching SQLite's own `datetime('now')` so
 * a value written by the application sorts and compares against a value written
 * by a default or by seed data.
 */
export function toDbTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export interface SessionWindow {
  issuedAt: string;
  expiresAt: string;
  /** Seconds, for the cookie's Max-Age, kept in step with expires_at. */
  maxAge: number;
}

/**
 * The issue and expiry pair for a new session. Computed together from one
 * instant so `expires_at >= issued_at` cannot be violated by clock movement
 * between two separate reads, which the schema's CHECK constraint would reject.
 */
export function sessionWindow(now: Date, ttlSeconds: number = SESSION_TTL_SECONDS): SessionWindow {
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  return {
    issuedAt: toDbTimestamp(now),
    expiresAt: toDbTimestamp(expires),
    maxAge: ttlSeconds,
  };
}

/** Whether a stored `expires_at` is in the past relative to `now`. */
export function isExpired(expiresAt: string, now: Date): boolean {
  return expiresAt < toDbTimestamp(now);
}
