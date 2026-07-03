/**
 * Global middleware: the Engineering Rhythm session guard.
 *
 * Host routing and the internal rewrite happen earlier, in src/worker.ts, so by
 * the time a request reaches here an engr-host request is already on its /engr
 * route. This middleware only guards those routes: the public entry points and
 * the self-secured machine endpoints pass through, then the session cookie is
 * read and verified. On failure, /engr/api/** returns 401 JSON and page requests
 * redirect to /login (root-relative, so the browser stays on the subdomain). On
 * success, locals.engr is attached with a bound can() helper. The organisation
 * id comes only from the verified session, never from a request parameter. Every
 * other request (the marketing site) passes straight through.
 */
import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { readSession } from '@engr/auth/session';
import { toAppPath, isPublicAppPath, isEngrApiPath } from '@engr/routing';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Only the product routes are guarded; the marketing site passes through.
  if (pathname !== '/engr' && !pathname.startsWith('/engr/')) return next();

  // The visitor-facing path (root-relative), for the active-nav check and links.
  const appPath = toAppPath(pathname);
  context.locals.engrPath = appPath;

  // Public entry points and self-secured machine endpoints need no session.
  if (isPublicAppPath(appPath)) return next();

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
    orgName: session.orgName,
    userName: session.userName,
    userEmail: session.userEmail,
    roles: session.roles,
    perms,
    can: (key: string) => perms.includes(key),
  };

  return next();
});
