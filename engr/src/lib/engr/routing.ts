/**
 * Hostname routing for Engineering Rhythm. One source of truth.
 *
 * The app files live under src/pages/engr/** but the app is served at the root of
 * engr.murikah.com, while the marketing site stays on murikah.com. Both are one
 * worker; the branch is decided by host in src/worker.ts, before the Astro
 * adapter resolves a route or serves a static asset (the adapter answers static
 * assets and the prerendered 404 before any middleware runs, which is why the
 * earlier middleware-only attempt could not gate the host on the edge).
 *
 * Pure string helpers, no imports, so the decisions can be unit tested directly.
 */

const ENGR_APEX = 'engr.murikah.com';
const ENGR_LOCAL = 'engr.localhost';
const MARKETING_APEX = 'murikah.com';
const MARKETING_WWW = 'www.murikah.com';
const ENGR_PREFIX = '/engr';

/**
 * The request host, taken from the Host header (the reliable source in a
 * Cloudflare Worker) and falling back to the URL only if the header is absent.
 * The port is stripped and the value is lower-cased so comparisons are exact.
 */
export function requestHost(request: Request): string {
  const raw = request.headers.get('host') ?? new URL(request.url).hostname;
  return raw.split(':')[0].trim().toLowerCase();
}

/** The corporate marketing site, and only this host. www is handled separately. */
export function isMarketingHost(host: string): boolean {
  return host === MARKETING_APEX;
}

/** The single non-canonical corporate host, redirected to the apex. */
export function isWwwHost(host: string): boolean {
  return host === MARKETING_WWW;
}

/**
 * The Engineering Rhythm app: engr.murikah.com, any sub-label of it (a future
 * per-tenant subdomain such as acme.engr.murikah.com), and the local development
 * equivalents engr.localhost and *.engr.localhost.
 */
export function isEngrHost(host: string): boolean {
  return (
    host === ENGR_APEX ||
    host.endsWith('.' + ENGR_APEX) ||
    host === ENGR_LOCAL ||
    host.endsWith('.' + ENGR_LOCAL)
  );
}

/**
 * Per-tenant subdomain hook. Parses the single tenant label from
 * {tenant}.engr.murikah.com (or .engr.localhost), returning null for the bare
 * host or a deeper name. NOT USED YET: login still resolves the tenant by the
 * organisation slug on the form. The seam is here so subdomain-based tenant
 * resolution has an obvious home; when it arrives, keep the session cookie
 * host-only per subdomain.
 */
export function tenantLabel(host: string): string | null {
  for (const base of [ENGR_APEX, ENGR_LOCAL]) {
    const suffix = '.' + base;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
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

/** The root-relative path a visitor sees, with any /engr prefix removed. Idempotent. */
export function toAppPath(pathname: string): string {
  if (pathname === ENGR_PREFIX) return '/';
  if (pathname.startsWith(ENGR_PREFIX + '/')) {
    const rest = pathname.slice(ENGR_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * A static asset or Astro infra route is served as it is on the engr host: no
 * /engr rewrite. App routes never begin with /_ and never carry a file
 * extension (ids are hex, slugs are alphanumeric with hyphens), so a dot in the
 * final segment marks an asset.
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

/** The branch the worker took, surfaced on every response as x-mrk-branch. */
export type Branch = 'marketing' | 'app' | 'redirect-www' | 'redirect-engr-path' | 'not-found-host';

export type RouteDecision =
  | { branch: 'app'; enginePath: string }
  | { branch: 'marketing' }
  | { branch: 'redirect-www'; location: string }
  | { branch: 'redirect-engr-path'; location: string }
  | { branch: 'not-found-host' };

/**
 * The single host branch. engr.murikah.com serves the app (rewriting to the
 * /engr route); www redirects to the apex; murikah.com serves marketing but
 * sends any /engr path to the subdomain; every other host is a neutral 404 so no
 * corporate content leaks onto a stray host.
 */
export function routeDecision(host: string, pathname: string, search: string): RouteDecision {
  if (isEngrHost(host)) {
    const enginePath = isPassthroughAsset(pathname) ? pathname : toEnginePath(pathname);
    return { branch: 'app', enginePath };
  }
  if (isWwwHost(host)) {
    return { branch: 'redirect-www', location: 'https://' + MARKETING_APEX + pathname + search };
  }
  if (isMarketingHost(host)) {
    if (pathname === ENGR_PREFIX || pathname.startsWith(ENGR_PREFIX + '/')) {
      return {
        branch: 'redirect-engr-path',
        location: 'https://' + ENGR_APEX + toAppPath(pathname) + search,
      };
    }
    return { branch: 'marketing' };
  }
  return { branch: 'not-found-host' };
}
