/**
 * Which CMS paths are public, and where each kind of user belongs.
 *
 * The decision is DEFAULT-DENY from one explicit list. `isPublicPath` returns
 * true only for paths named below; everything else on this host needs a
 * session. That direction matters: a page added next month is protected
 * because nobody had to remember to protect it, which is the opposite of a
 * list of protected paths where the failure mode is silent exposure.
 *
 * Paths here are visitor-facing and root-relative, the form the middleware
 * gets from `toCmsAppPath`. The worker has already stripped the internal /cms
 * prefix by then, so nothing in this file mentions it.
 */

/** The internal application. Everything under it needs an INTERNAL session. */
import { canViewExecutiveDashboard } from './permissions.ts';

export const APP_ROOT = '/app';
/** The customer surface. Everything under it needs an EXTERNAL session. */
export const PORTAL_ROOT = '/portal';
export const LOGIN_PATH = '/login';

/**
 * The complete public list. Two entries, and adding a third should feel like a
 * decision rather than a convenience.
 *
 * `/api/auth/login` is here because sign-in cannot require a session. The other
 * two auth endpoints are not: they answer 401 themselves rather than being
 * redirected, which is what an API client expects.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([LOGIN_PATH, '/api/auth/login']);

export function isPublicPath(appPath: string): boolean {
  return PUBLIC_PATHS.has(appPath);
}

/** An API path answers 401 rather than redirecting to a sign-in page. */
export function isApiPath(appPath: string): boolean {
  return appPath === '/api' || appPath.startsWith('/api/');
}

export function isAppPath(appPath: string): boolean {
  return appPath === APP_ROOT || appPath.startsWith(APP_ROOT + '/');
}

export function isPortalPath(appPath: string): boolean {
  return appPath === PORTAL_ROOT || appPath.startsWith(PORTAL_ROOT + '/');
}

/** The executive dashboard, when it is somebody's home rather than a page. */
export const EXECUTIVE_HOME = '/app/executive';

/**
 * Where a signed-in user's home is: their user type first, then what they hold.
 *
 * NOTHING HERE READS A NAME. No email address, no user id, no job title. A
 * person lands on the executive dashboard because somebody granted them
 * EXECUTIVE.DASHBOARD.VIEW, and the same code path sends everyone else to Home.
 * Permissions are optional so the existing call sites that only know a user
 * type keep their previous answer rather than silently landing somebody
 * somewhere new.
 */
export function homeFor(userType: string, permissions: readonly string[] = []): string {
  if (userType === 'EXTERNAL') return PORTAL_ROOT;
  return canViewExecutiveDashboard(permissions) ? EXECUTIVE_HOME : APP_ROOT;
}

/**
 * The query flag that turns the sign-in page's expiry notice on, and the exact
 * sentence it renders. Kept beside the flag so the two cannot drift.
 */
export const EXPIRED_FLAG = 'expired';
export const EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';
