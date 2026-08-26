/**
 * The session cookie.
 *
 * Named `cms_session`, matching the previous CMS, so the name is one fewer
 * thing that changed. Host-only and scoped to this product, so it is never sent
 * to the marketing apex, engr or grc.
 *
 * The raw token is the entire cookie value. Nothing else is put in it: no user
 * id, no role, no expiry claim. A cookie the client can read is a cookie the
 * client can be tempted to trust, and every fact about the session already
 * lives in `auth_sessions` where it can be revoked.
 */

export const SESSION_COOKIE_NAME = 'cms_session';

export interface CookieOptions {
  /** Secure is set in production and omitted on plain-http local development. */
  secure: boolean;
  /** Seconds. Kept in step with the session's `expires_at`. */
  maxAge: number;
}

/**
 * `SameSite=Strict` rather than Lax. This application has no inbound flow that
 * needs the cookie on a cross-site navigation: there is no OAuth callback, no
 * payment return, no emailed deep link that must arrive authenticated. Strict
 * therefore costs nothing and removes the residual cross-site request surface
 * that Lax still permits on top-level GET.
 */
function baseAttributes(options: CookieOptions): string[] {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (options.secure) attributes.push('Secure');
  return attributes;
}

/** The `Set-Cookie` value that establishes a session. */
export function serialiseSessionCookie(rawToken: string, options: CookieOptions): string {
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    ...baseAttributes(options),
    `Max-Age=${options.maxAge}`,
  ].join('; ');
}

/**
 * The `Set-Cookie` value that clears a session. Same attributes as the cookie
 * it replaces, because a browser matches on name, path and domain: a clear that
 * differs in Path or Secure leaves the original cookie in place.
 */
export function clearSessionCookie(options: Pick<CookieOptions, 'secure'>): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    ...baseAttributes({ ...options, maxAge: 0 }),
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

/**
 * Read the raw token from a request's Cookie header, or null.
 *
 * Parses only the name it wants and ignores the rest, so a malformed neighbour
 * cookie cannot break the session lookup.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Whether the request arrived over https, which decides the Secure flag.
 * Cloudflare terminates TLS and forwards the original scheme, so the header is
 * the authority rather than the rewritten internal URL.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}
