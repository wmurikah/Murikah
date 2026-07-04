/**
 * The GRC acting-organisation cookie.
 *
 * A platform owner (Wilberforce) can act inside any organisation. The choice is
 * held in a signed, HttpOnly cookie (HS256, GRC_SESSION_SECRET), separate from
 * engr's. The cookie is only ever a hint: the middleware re-validates the acting
 * organisation against the user's entitlement on every request, and only for a
 * platform owner, so a tampered or stale value can never grant access to an
 * ordinary user or outside the set. Confined to the subdomain (Path=/,
 * host-only), Secure gated on the caller.
 */
import { SignJWT, jwtVerify } from 'jose';

export const GRC_ACTING_COOKIE = 'grc_acting_org';
const MAX_AGE_SECONDS = 12 * 60 * 60; // matches the session

function keyFromSecret(secret: string): Uint8Array {
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Read and verify the acting-org cookie, returning the organization id or null. */
export async function readActingOrg(request: Request, secret: string): Promise<string | null> {
  const token = readCookie(request, GRC_ACTING_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFromSecret(secret), { algorithms: ['HS256'] });
    return typeof payload.act === 'string' ? payload.act : null;
  } catch {
    return null;
  }
}

/** The Set-Cookie value that records the acting organisation. */
export async function createActingCookie(
  organizationId: string,
  secret: string,
  secure: boolean,
): Promise<string> {
  const token = await new SignJWT({ act: organizationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(keyFromSecret(secret));
  const secureAttr = secure ? '; Secure' : '';
  return `${GRC_ACTING_COOKIE}=${token}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}
