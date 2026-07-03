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
import { getDb } from '@engr/db';
import { readSession } from '@engr/auth/session';
import { readActingOrg } from '@engr/auth/actingOrg';
import { resolveActingContext, type SwitchOrg } from '@engr/repos/orgContext';
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

  let env: ReturnType<typeof getEngrEnv>;
  try {
    env = getEngrEnv();
  } catch {
    // Misconfigured environment: fail closed rather than exposing anything.
    return isApi
      ? jsonResponse({ error: 'unavailable' }, 503)
      : new Response('Engineering Rhythm is not configured.', { status: 503 });
  }

  const session = await readSession(context.request, env.sessionSecret);
  if (!session) {
    return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect('/login');
  }

  const homeOrgId = session.org;
  const homeName = session.orgName ?? session.orgSlug;
  const homeSlug = session.orgSlug;

  // The acting organisation. It defaults to the home organisation and only ever
  // differs for a group super-admin (resolved and validated from the database);
  // an ordinary user acts inside their home organisation with no extra query.
  let actingOrgId = homeOrgId;
  let actingName: string = homeName;
  let actingSlug = homeSlug;
  let isGroupAdmin = false;
  let isPlatformOwner = false;
  let switchable: SwitchOrg[] = [];
  // The platform owner is an OWNER of their home group, so this admin branch also
  // covers them; the resolver reads users.is_platform_owner to widen their scope.
  const isAdminRole = session.roles.includes('OWNER') || session.roles.includes('ADMIN');
  if (isAdminRole) {
    try {
      const requested = await readActingOrg(context.request, env.sessionSecret);
      const db = await getDb(env);
      const ctx = await resolveActingContext(
        db,
        homeOrgId,
        homeName,
        homeSlug,
        session.roles,
        requested,
        session.sub,
      );
      actingOrgId = ctx.actingOrgId;
      actingName = ctx.actingName;
      actingSlug = ctx.actingSlug;
      isGroupAdmin = ctx.isGroupAdmin;
      isPlatformOwner = ctx.isPlatformOwner;
      switchable = ctx.switchable;
    } catch {
      // On any resolution failure act inside the home organisation, never wider.
      actingOrgId = homeOrgId;
    }
  }

  // A group super-admin acting inside an affiliate keeps their full (OWNER)
  // permission set for that affiliate; an ordinary user keeps their own rights.
  const perms = session.perms;
  context.locals.engr = {
    userId: session.sub,
    orgId: actingOrgId,
    homeOrgId,
    orgSlug: actingSlug,
    orgName: actingName,
    userName: session.userName,
    userEmail: session.userEmail,
    isGroupAdmin,
    isPlatformOwner,
    switchable,
    roles: session.roles,
    perms,
    can: (key: string) => perms.includes(key),
  };

  return next();
});
