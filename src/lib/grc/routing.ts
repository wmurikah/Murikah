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

// The only paths a half-authorised (MFA pending) session may reach: the
// verification step, its endpoint, the code resend, and sign-out. Everything
// else redirects to the step. Verification is universal (Build Prompt 37):
// every sign-in passes through this confinement, and there is no enrolment
// wall any more, because email codes are the automatic default.
const MFA_PENDING_ALLOWED = new Set([
  '/mfa',
  '/api/auth/mfa/verify',
  '/api/auth/mfa/send',
  '/api/auth/logout',
]);

export function isGrcMfaPendingAllowed(appPath: string): boolean {
  return MFA_PENDING_ALLOWED.has(appPath);
}

/** The verification step, in root-relative form. */
export const GRC_MFA_PATH = '/mfa';

/** The all-instances view: where a platform owner lands and picks an instance. */
export const GRC_PLATFORM_PATH = '/platform';

// A platform owner is pinned to no organisation, so until they select an
// instance there is no acting organisation to scope a query by. These are the
// only paths that still work in that state: the all-instances view itself, the
// two endpoints that enter and leave an instance, and the account-level flows,
// which scope by the user's home organisation rather than the acting one. Every
// module path needs an instance and is sent to the all-instances view to pick
// one, never defaulted silently into someone's organisation.
const INSTANCE_FREE_PATHS = new Set([
  GRC_PLATFORM_PATH,
  '/api/org/switch',
  '/api/org/leave',
  // Provisioning creates an instance; it does not act inside one, so it is
  // reachable from the all-instances view.
  '/settings/provision',
  '/api/organizations',
  '/change-password',
  '/api/auth/change-password',
  '/mfa',
  '/mfa/setup',
  '/api/auth/mfa/send',
  '/api/auth/mfa/verify',
  '/api/auth/mfa/enrol',
  '/api/auth/mfa/confirm',
  '/api/auth/mfa/backup',
  '/api/auth/logout',
]);

/** Whether a root-relative app path works with no instance selected. */
export function isGrcInstanceFreePath(appPath: string): boolean {
  return INSTANCE_FREE_PATHS.has(appPath);
}

/** The account security screen (backup codes and the authenticator setup). */
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
