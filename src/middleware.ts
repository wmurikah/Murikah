/**
 * Global middleware.
 *
 * Only requests under /engr are affected; every other path (the marketing site)
 * passes straight through, so it is unaffected. For /engr requests the public
 * entry points are skipped, then the session cookie is read and verified. On
 * failure, /engr/api/** returns 401 JSON and page requests redirect to
 * /engr/login. On success, locals.engr is attached with a bound can() helper.
 * The organisation id comes only from the verified session, never from a
 * request parameter or form field.
 */
import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { readSession } from '@engr/auth/session';

const PUBLIC_PATHS = new Set(['/engr/login', '/engr/api/auth/login']);

// Machine endpoints that carry their own shared-secret auth and must not require
// a user session: the Cron drain triggers and the provider delivery webhooks.
const PUBLIC_PREFIXES = ['/engr/api/cron/', '/engr/api/webhooks/'];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Not the product: leave the marketing site completely alone.
  if (pathname !== '/engr' && !pathname.startsWith('/engr/')) {
    return next();
  }

  // Public entry points and self-secured machine endpoints need no session.
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return next();
  }

  const isApi = pathname.startsWith('/engr/api/');

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
    return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect('/engr/login');
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

  return next();
});
