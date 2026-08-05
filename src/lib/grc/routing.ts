/**
 * Hostname routing for the GRC platform. The mirror of engr's routing, kept as a
 * separate self-contained module (no imports) so it can be unit tested directly
 * and so the two products never entangle. The app files live under
 * src/pages/grc/** but the app is served at the root of grc.murikah.com; the
 * worker (src/worker.ts) decides the branch by host and rewrites internally to
 * the /grc route, leaving the browser URL clean. engr.murikah.com and the
 * marketing apex are unaffected.
 */

const GRC_APEX = 'grc.murikah.com';
const GRC_LOCAL = 'grc.localhost';
const GRC_PREFIX = '/grc';

/**
 * The GRC app: grc.murikah.com, any sub-label of it (a future per-tenant
 * subdomain), and the local development equivalents grc.localhost and
 * *.grc.localhost.
 */
export function isGrcHost(host: string): boolean {
  return (
    host === GRC_APEX ||
    host.endsWith('.' + GRC_APEX) ||
    host === GRC_LOCAL ||
    host.endsWith('.' + GRC_LOCAL)
  );
}

/** The internal route path under /grc for an incoming app path. Idempotent. */
export function toGrcPath(pathname: string): string {
  if (pathname === GRC_PREFIX || pathname.startsWith(GRC_PREFIX + '/')) return pathname;
  if (pathname === '/') return GRC_PREFIX;
  return GRC_PREFIX + pathname;
}

/** The root-relative path a visitor sees, with any /grc prefix removed. Idempotent. */
export function toGrcAppPath(pathname: string): string {
  if (pathname === GRC_PREFIX) return '/';
  if (pathname.startsWith(GRC_PREFIX + '/')) {
    const rest = pathname.slice(GRC_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * A static asset or Astro infra route is served as it is on the grc host: no
 * /grc rewrite. App routes never begin with /_ and never carry a file extension.
 */
export function isGrcPassthroughAsset(pathname: string): boolean {
  return pathname.startsWith('/_') || /\.[a-z0-9]+$/i.test(pathname);
}

// Public, unauthenticated app paths on the grc host, in root-relative form: the
// sign-in screen and endpoint, and the forgotten-password flow (its two screens
// and endpoints), which by nature runs before a session exists.
const PUBLIC_GRC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/forgot-password',
  '/api/auth/forgot-password',
  '/reset-password',
  '/api/auth/reset-password',
]);

export function isGrcPublicPath(appPath: string): boolean {
  return PUBLIC_GRC_PATHS.has(appPath);
}

/** Whether a root-relative app path is an API route (401 JSON on no session). */
export function isGrcApiPath(appPath: string): boolean {
  return appPath === '/api' || appPath.startsWith('/api/');
}

// The only paths a user with must_change_password set may still reach: the
// change-password screen, its endpoint, and sign-out. Everything else is
// redirected to the change-password screen until the flag clears.
const CHANGE_PASSWORD_EXEMPT = new Set([
  '/change-password',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

export function isGrcChangePasswordExempt(appPath: string): boolean {
  return CHANGE_PASSWORD_EXEMPT.has(appPath);
}

/** The change-password screen, in root-relative form. */
export const GRC_CHANGE_PASSWORD_PATH = '/change-password';

// The only paths a half-authorised (MFA pending) session may reach: the TOTP
// step, its endpoint, and sign-out. Everything else redirects to the step.
const MFA_PENDING_ALLOWED = new Set(['/mfa', '/api/auth/mfa/verify', '/api/auth/logout']);

export function isGrcMfaPendingAllowed(appPath: string): boolean {
  return MFA_PENDING_ALLOWED.has(appPath);
}

// The only paths a user whose role requires MFA may reach before enrolling:
// the enrolment screen and its endpoints, sign-out, and the change-password
// flow (a forced password change may precede enrolment).
const MFA_ENROL_EXEMPT = new Set([
  '/mfa/setup',
  '/api/auth/mfa/enrol',
  '/api/auth/mfa/confirm',
  '/api/auth/logout',
  '/change-password',
  '/api/auth/change-password',
]);

export function isGrcMfaEnrolExempt(appPath: string): boolean {
  return MFA_ENROL_EXEMPT.has(appPath);
}

/** The TOTP verification step, in root-relative form. */
export const GRC_MFA_PATH = '/mfa';

/** The enrolment screen, in root-relative form. */
export const GRC_MFA_SETUP_PATH = '/mfa/setup';

/**
 * On the marketing apex, a /grc path is sent to the subdomain, mirroring how
 * /engr is redirected. Returns the absolute location, or null when the path is
 * not a grc path (so the marketing site renders normally).
 */
export function grcMarketingRedirect(pathname: string, search: string): string | null {
  if (pathname === GRC_PREFIX || pathname.startsWith(GRC_PREFIX + '/')) {
    return 'https://' + GRC_APEX + toGrcAppPath(pathname) + search;
  }
  return null;
}

export const GRC_HOST = GRC_APEX;
