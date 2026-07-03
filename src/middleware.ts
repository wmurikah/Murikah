/**
 * Global middleware. Routing is by hostname (one worker, two sites).
 *
 * On engr.murikah.com (and the local engr.localhost) the Engineering Rhythm app
 * is served at the root: the request is rewritten internally to the matching
 * file under src/pages/engr/**, so engr.murikah.com/login renders
 * src/pages/engr/login.astro while the browser URL stays clean. The session
 * guard then runs against the root-relative path; an unauthenticated page
 * request redirects to /login on the same host, an unauthenticated API request
 * returns 401 JSON. Static assets and the public entry points pass through
 * without a session.
 *
 * On murikah.com the marketing site is served exactly as before, except that any
 * old /engr/* path is redirected once to the subdomain. Every other path passes
 * straight through.
 *
 * The rewrite is guarded so it cannot loop: assets pass through, and a path that
 * already begins /engr is not rewritten again. The organisation id comes only
 * from the verified session, never from a request parameter or form field.
 */
import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { readSession } from '@engr/auth/session';
import {
  isEngrHost,
  toEnginePath,
  toAppPath,
  isPassthroughAsset,
  isPublicAppPath,
  isEngrApiPath,
  marketingEngrRedirect,
} from '@engr/routing';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { hostname, pathname, search } = context.url;

  // Marketing host: leave it alone, but move any old /engr/* link permanently to
  // the subdomain, query string preserved.
  if (!isEngrHost(hostname)) {
    const location = marketingEngrRedirect(pathname, search);
    if (location) return new Response(null, { status: 301, headers: { location } });
    return next();
  }

  // Engineering Rhythm host. Static assets and Astro infra routes are served as
  // they are, with no rewrite and no session.
  if (isPassthroughAsset(pathname)) return next();

  const appPath = toAppPath(pathname);
  const enginePath = toEnginePath(pathname);

  // The visitor-facing path, before the internal rewrite. Astro.url reflects the
  // rewritten /engr path once next() runs, so anything building a canonical link
  // reads these instead (the layout's active-nav check does).
  context.locals.engrHost = hostname;
  context.locals.engrPath = appPath;

  // Per-tenant subdomains resolve here in a later change; ignored for now so
  // login keeps resolving the tenant by the organisation slug on the form.
  // const tenant = tenantLabel(hostname);

  if (!isPublicAppPath(appPath)) {
    const isApi = isEngrApiPath(appPath);

    let sessionSecret: string;
    try {
      sessionSecret = getEngrEnv().sessionSecret;
    } catch {
      // Misconfigured environment: fail closed rather than exposing anything.
      return isApi
        ? jsonResponse({ error: 'unavailable' }, 503)
        : new Response('Engineering Rhythm is not configured.', { status: 503 });
    }

    const session = await readSession(context.request, sessionSecret);
    if (!session) {
      return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect('/login');
    }

    const perms = session.perms;
    context.locals.engr = {
      userId: session.sub,
      orgId: session.org,
      orgSlug: session.orgSlug,
      roles: session.roles,
      perms,
      can: (key: string) => perms.includes(key),
    };
  }

  // Rewrite to the file under /engr. Guarded against a loop: the asset check
  // above and this prefix check mean a re-entry on the rewritten /engr path does
  // not rewrite a second time.
  if (enginePath !== pathname) return next(enginePath + search);
  return next();
});
