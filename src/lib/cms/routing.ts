/**
 * Hostname routing for the Hass CMS platform. The mirror of engr's and grc's
 * routing, kept as a separate self-contained module (no imports) so it can be
 * unit tested directly and so the three products never entangle. The app files
 * live under src/pages/cms/** but the app is served at the root of
 * cms.murikah.com; the worker (src/worker.ts) decides the branch by host and
 * rewrites internally to the /cms route, leaving the browser URL clean.
 * engr.murikah.com, grc.murikah.com and the marketing apex are unaffected.
 */

const CMS_APEX = 'cms.murikah.com';
const CMS_LOCAL = 'cms.localhost';
const CMS_PREFIX = '/cms';

/**
 * The CMS app: cms.murikah.com, any sub-label of it (a future per-tenant
 * subdomain), and the local development equivalents cms.localhost and
 * *.cms.localhost.
 */
export function isCmsHost(host: string): boolean {
  return (
    host === CMS_APEX ||
    host.endsWith('.' + CMS_APEX) ||
    host === CMS_LOCAL ||
    host.endsWith('.' + CMS_LOCAL)
  );
}

/** The internal route path under /cms for an incoming app path. Idempotent. */
export function toCmsPath(pathname: string): string {
  if (pathname === CMS_PREFIX || pathname.startsWith(CMS_PREFIX + '/')) return pathname;
  if (pathname === '/') return CMS_PREFIX;
  return CMS_PREFIX + pathname;
}

/** The root-relative path a visitor sees, with any /cms prefix removed. Idempotent. */
export function toCmsAppPath(pathname: string): string {
  if (pathname === CMS_PREFIX) return '/';
  if (pathname.startsWith(CMS_PREFIX + '/')) {
    const rest = pathname.slice(CMS_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * A static asset or Astro infra route is served as it is on the cms host: no
 * /cms rewrite. App routes never begin with /_ and never carry a file extension.
 */
export function isCmsPassthroughAsset(pathname: string): boolean {
  return pathname.startsWith('/_') || /\.[a-z0-9]+$/i.test(pathname);
}

// Public, unauthenticated app paths on the cms host, in root-relative form: the
// staff and customer sign-in screens, the sign-in endpoint, and the MFA step
// (which runs on a half-authorised session before the cookie is fully trusted).
const PUBLIC_CMS_PATHS = new Set([
  '/login',
  '/portal/login',
  '/api/auth/login',
  '/mfa',
  '/api/auth/mfa',
]);

export function isCmsPublicPath(appPath: string): boolean {
  return PUBLIC_CMS_PATHS.has(appPath);
}

/** Whether a root-relative app path is an API route (401 JSON on no session). */
export function isCmsApiPath(appPath: string): boolean {
  return appPath === '/api' || appPath.startsWith('/api/');
}

/** Whether a root-relative app path is on the customer portal (customer surface). */
export function isCmsPortalPath(appPath: string): boolean {
  return appPath === '/portal' || appPath.startsWith('/portal/');
}

/**
 * On the marketing apex, a /cms path is sent to the subdomain, mirroring how
 * /engr and /grc paths are redirected. Returns the absolute location, or null
 * when the path is not a cms path (so the marketing site renders normally).
 */
export function cmsMarketingRedirect(pathname: string, search: string): string | null {
  if (pathname === CMS_PREFIX || pathname.startsWith(CMS_PREFIX + '/')) {
    return 'https://' + CMS_APEX + toCmsAppPath(pathname) + search;
  }
  return null;
}

export const CMS_HOST = CMS_APEX;
