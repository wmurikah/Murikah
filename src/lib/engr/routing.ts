/**
 * Hostname routing for Engineering Rhythm.
 *
 * The app files live under src/pages/engr/** but the app is served at the root of
 * engr.murikah.com, while the marketing site stays on murikah.com. Both are one
 * worker; routing is by hostname. All of the host logic lives here and in
 * src/middleware.ts so the pages and endpoints never need to know which host
 * serves them.
 *
 * Pure string helpers, no imports, so the routing decisions can be unit tested
 * directly with node --test.
 */

const ENGR_APEX = 'engr.murikah.com';
const ENGR_LOCAL = 'engr.localhost';
const ENGR_PREFIX = '/engr';

/**
 * True for engr.murikah.com, any sub-label of it (a future per-tenant subdomain
 * such as acme.engr.murikah.com), and the local development equivalents
 * engr.localhost and *.engr.localhost.
 */
export function isEngrHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === ENGR_APEX ||
    h.endsWith('.' + ENGR_APEX) ||
    h === ENGR_LOCAL ||
    h.endsWith('.' + ENGR_LOCAL)
  );
}

/**
 * Per-tenant subdomain hook. Parses the single tenant label from
 * {tenant}.engr.murikah.com (or .engr.localhost), returning null for the bare
 * host or a deeper name.
 *
 * NOT USED YET: login still resolves the tenant by the organisation slug on the
 * form, as built in Prompt 1. The seam is here, clearly marked, so that
 * subdomain-based tenant resolution has an obvious home when it arrives. When it
 * does, keep the session cookie host-only per subdomain (see auth/session.ts);
 * do not widen it to a shared parent domain.
 */
export function tenantLabel(hostname: string): string | null {
  const h = hostname.toLowerCase();
  for (const base of [ENGR_APEX, ENGR_LOCAL]) {
    const suffix = '.' + base;
    if (h.endsWith(suffix)) {
      const label = h.slice(0, -suffix.length);
      if (label && !label.includes('.')) return label;
    }
  }
  return null;
}

/** The internal route path under /engr for an incoming app path. Idempotent. */
export function toEnginePath(pathname: string): string {
  if (pathname === ENGR_PREFIX || pathname.startsWith(ENGR_PREFIX + '/')) return pathname;
  if (pathname === '/') return ENGR_PREFIX;
  return ENGR_PREFIX + pathname;
}

/**
 * The root-relative path a visitor sees, with any /engr prefix removed. This is
 * what the app treats as canonical on engr.murikah.com. Idempotent.
 */
export function toAppPath(pathname: string): string {
  if (pathname === ENGR_PREFIX) return '/';
  if (pathname.startsWith(ENGR_PREFIX + '/')) {
    const rest = pathname.slice(ENGR_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * A static asset or Astro infra route passes straight through on the engr host:
 * no /engr rewrite and no session. App routes never begin with /_ and never
 * carry a file extension (ids are hex, slugs are alphanumeric with hyphens), so
 * a dot in the final segment marks an asset.
 */
export function isPassthroughAsset(pathname: string): boolean {
  return pathname.startsWith('/_') || /\.[a-z0-9]+$/i.test(pathname);
}

// Public, unauthenticated app paths on the engr host, in root-relative form:
// the login screen, the login endpoint, and the self-secured machine endpoints
// (the cron drains and the provider delivery webhooks carry their own secret).
const PUBLIC_APP_PATHS = new Set(['/login', '/api/auth/login']);
const PUBLIC_APP_PREFIXES = ['/api/cron/', '/api/webhooks/'];

export function isPublicAppPath(appPath: string): boolean {
  return PUBLIC_APP_PATHS.has(appPath) || PUBLIC_APP_PREFIXES.some((p) => appPath.startsWith(p));
}

/** Whether a root-relative app path is an API route (401 JSON on no session). */
export function isEngrApiPath(appPath: string): boolean {
  return appPath === '/api' || appPath.startsWith('/api/');
}

/**
 * On the marketing host, the old /engr/* path has moved permanently to the
 * subdomain. Returns the absolute redirect target with the query string
 * preserved, or null when the path is not under /engr so the marketing site is
 * left untouched.
 */
export function marketingEngrRedirect(pathname: string, search: string): string | null {
  if (pathname !== ENGR_PREFIX && !pathname.startsWith(ENGR_PREFIX + '/')) return null;
  return 'https://' + ENGR_APEX + toAppPath(pathname) + search;
}
