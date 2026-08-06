/**
 * Global middleware: the session guards for both products.
 *
 * Host routing and the internal rewrite happen earlier, in src/worker.ts, so by
 * the time a request reaches here an engr-host request is on its /engr route and
 * a grc-host request is on its /grc route. This middleware guards each: the
 * public entry points pass through, then the session is read and verified. On
 * failure, an API path returns 401 JSON and a page redirects to /login
 * (root-relative, so the browser stays on the subdomain). On success the request
 * context is attached to locals, and every downstream query scopes by the
 * organisation resolved from the verified session, never from a request
 * parameter. Every other request (the marketing site) passes straight through.
 *
 * The two products are independent: engr uses a stateless JWT and org_id; grc
 * uses a DB-backed session and organization_id, with a single role_code.
 */
import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { getDb as getEngrDb } from '@engr/db';
import { readSession } from '@engr/auth/session';
import { readActingOrg } from '@engr/auth/actingOrg';
import { resolveActingContext, type SwitchOrg } from '@engr/repos/orgContext';
import { toAppPath, isPublicAppPath, isEngrApiPath } from '@engr/routing';
import { getGrcEnv } from '@grc/env';
import { getDb as getGrcDb } from '@grc/db';
import { readGrcSessionCookie } from '@grc/auth/session';
import { readActingOrg as readGrcActingOrg } from '@grc/auth/actingOrg';
import { resolveSession } from '@grc/repos/session';
import {
  resolveActingContext as resolveGrcActingContext,
  type SwitchOrg as GrcSwitchOrg,
} from '@grc/repos/orgContext';
import { getPermissionMatrix, deriveLegacyPerms, canMatrix, fullMatrix } from '@grc/auth/rbac';
import { pageAccess, pageSlugForPath } from '@grc/auth/matrix';
import { loadSubscription } from '@grc/repos/features';
import {
  toGrcAppPath,
  isGrcPublicPath,
  isGrcApiPath,
  isGrcChangePasswordExempt,
  isGrcMfaPendingAllowed,
  GRC_CHANGE_PASSWORD_PATH,
  GRC_MFA_PATH,
} from '@grc/routing';
import { logGrcError, grcErrorResponse } from '@grc/errorBoundary';
import { getCmsEnv } from '@cms/env';
import { getDb as getCmsDb } from '@cms/db';
import { readSessionCookie } from '@cms/auth/session';
import {
  resolveSession as resolveCmsSession,
  touchSession,
  getDisplayIdentity,
} from '@cms/repos/session';
import { loadRolePermissions, can as cmsCan } from '@cms/auth/rbac';
import { loadBranding } from '@cms/repos/branding';
import { resolveTenant } from '@cms/tenancy';
import { toCmsAppPath, isCmsPublicPath, isCmsApiPath, isCmsPortalPath } from '@cms/routing';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // ---- GRC platform guard (/grc routes) ------------------------------------
  if (pathname === '/grc' || pathname.startsWith('/grc/')) {
    const appPath = toGrcAppPath(pathname);
    context.locals.grcPath = appPath;

    const isApi = isGrcApiPath(appPath);

    // The last-resort error boundary (Build Prompt 22): anything the guard's own
    // queries or a downstream route throws becomes a logged, branded response,
    // a safe JSON error for an API path, the branded error screen for a page,
    // never a blank 500. Pages carry their inline boundary (guardPageLoad) so
    // the shell survives a data failure; this catches everything else.
    const guarded = async (): Promise<Response> => {
      if (isGrcPublicPath(appPath)) return next();

      let env: ReturnType<typeof getGrcEnv>;
      try {
        env = getGrcEnv();
      } catch {
        return isApi
          ? jsonResponse({ error: 'unavailable' }, 503)
          : new Response('The GRC platform is not configured.', { status: 503 });
      }

      const sessionCookie = await readGrcSessionCookie(context.request, env.sessionSecret);
      if (!sessionCookie) {
        return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect('/login');
      }
      const sessionId = sessionCookie.sessionId;

      // Two-step verification is universal (Build Prompt 37): every sign-in
      // starts half-authorised (mfa=pending) and may only reach the
      // verification step and sign-out until the second factor clears; the
      // step's endpoint resolves the session itself, so no locals are
      // attached before then. There is no enrolment wall: email codes are
      // the automatic default and need no setup.
      if (sessionCookie.mfa === 'pending') {
        if (isGrcMfaPendingAllowed(appPath)) return next();
        return isApi
          ? jsonResponse({ error: 'mfa_required' }, 401)
          : context.redirect(GRC_MFA_PATH);
      }

      const db = await getGrcDb(env);
      const identity = await resolveSession(db, sessionId);
      if (!identity) {
        return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect('/login');
      }

      // The acting organisation defaults to home. Only a platform owner may act
      // elsewhere, resolved and validated from the database; every other user is
      // fixed to their home organisation, so a crafted acting cookie is never read.
      let organizationId = identity.homeOrganizationId;
      let organizationName = identity.homeOrganizationName;
      let switchable: GrcSwitchOrg[] = [];
      if (identity.isPlatformOwner) {
        try {
          const requested = await readGrcActingOrg(context.request, env.sessionSecret);
          const acting = await resolveGrcActingContext(
            db,
            identity.homeOrganizationId,
            identity.homeOrganizationName,
            true,
            requested,
          );
          organizationId = acting.actingOrganizationId;
          organizationName = acting.actingName;
          switchable = acting.switchable;
        } catch {
          organizationId = identity.homeOrganizationId;
        }
      }

      // The permission matrix from role_permissions drives every gate. A SUPER_ADMIN
      // and a platform owner hold the full matrix; every other role holds its grants.
      // The legacy perms list is derived from the matrix, so existing code keeps
      // working, matrix-driven.
      const matrix =
        identity.isPlatformOwner || identity.roleCode === 'SUPER_ADMIN'
          ? fullMatrix()
          : await getPermissionMatrix(db, identity.roleCode);
      const perms = deriveLegacyPerms(matrix);
      const subscription = await loadSubscription(db, organizationId);
      const features = subscription.features;

      context.locals.grc = {
        userId: identity.userId,
        organizationId,
        homeOrganizationId: identity.homeOrganizationId,
        organizationName,
        roleCode: identity.roleCode,
        userName: identity.userName,
        userEmail: identity.userEmail,
        isPlatformOwner: identity.isPlatformOwner,
        mustChangePassword: identity.mustChangePassword,
        switchable,
        matrix,
        perms,
        features,
        can: (action: string, module: string) => canMatrix(matrix, action, module),
        // A platform owner is entitled to every feature regardless of the acting
        // organisation's plan; an ordinary user is gated by their plan flags.
        hasFeature: (flag: string) => identity.isPlatformOwner || features[flag] === true,
      };

      // A temporary password locks the account to the change-password flow: every
      // route but the change-password screen, its endpoint and sign-out is sent
      // there until the flag clears. locals.grc is still set, so the screen has
      // the acting context.
      if (identity.mustChangePassword && !isGrcChangePasswordExempt(appPath)) {
        return isApi
          ? jsonResponse({ error: 'password_change_required' }, 403)
          : context.redirect(GRC_CHANGE_PASSWORD_PATH);
      }

      // Central page-map enforcement (PAGE_PERMISSION_MAP): a page section the
      // matrix does not unlock redirects to the dashboard before the page runs.
      // Unmapped sections (dashboard, notifications, change-password) pass and
      // gate themselves; API endpoints carry their own gates.
      if (!isApi && !pageAccess(matrix, pageSlugForPath(appPath))) {
        return context.redirect('/');
      }

      return next();
    };

    try {
      return await guarded();
    } catch (err) {
      logGrcError(appPath, err);
      return grcErrorResponse(isApi);
    }
  }

  // ---- Hass CMS guard (/cms routes) ----------------------------------------
  if (pathname === '/cms' || pathname.startsWith('/cms/')) {
    const appPath = toCmsAppPath(pathname);
    context.locals.cmsPath = appPath;

    if (isCmsPublicPath(appPath)) return next();
    const isApi = isCmsApiPath(appPath);
    const loginPath = isCmsPortalPath(appPath) ? '/portal/login' : '/login';

    let env: ReturnType<typeof getCmsEnv>;
    try {
      env = getCmsEnv();
    } catch {
      return isApi
        ? jsonResponse({ error: 'unavailable' }, 503)
        : new Response('Hass CMS is not configured.', { status: 503 });
    }

    const cookie = await readSessionCookie(context.request, env.sessionSecret);
    if (!cookie) {
      return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect(loginPath);
    }

    const db = await getCmsDb(env);
    const identity = await resolveCmsSession(db, cookie.sessionId);
    if (!identity) {
      return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : context.redirect(loginPath);
    }

    // A half-authorised (MFA pending) session may only reach the TOTP step.
    if (cookie.mfa === 'pending') {
      if (appPath === '/mfa') return next();
      return isApi ? jsonResponse({ error: 'mfa_required' }, 401) : context.redirect('/mfa');
    }

    // The two user types never cross: a customer is confined to the portal, a
    // staff user is kept out of it. Sign-out and the MFA step are shared.
    const onPortal = isCmsPortalPath(appPath);
    if (identity.userType === 'CUSTOMER' && !onPortal && appPath !== '/mfa') {
      return isApi ? jsonResponse({ error: 'forbidden' }, 403) : context.redirect('/portal');
    }
    if (identity.userType === 'STAFF' && onPortal) {
      return isApi ? jsonResponse({ error: 'forbidden' }, 403) : context.redirect('/');
    }

    const [perms, display] = await Promise.all([
      identity.role ? loadRolePermissions(db, identity.role) : Promise.resolve(new Set<string>()),
      getDisplayIdentity(db, identity.userType, identity.userId),
    ]);
    const tenant = resolveTenant(identity.role);
    const branding = await loadBranding(db, identity.countryCode);
    await touchSession(db, cookie.sessionId);

    context.locals.cms = {
      userType: identity.userType,
      userId: identity.userId,
      role: identity.role,
      countryCode: identity.countryCode,
      customerId: display?.customerId ?? null,
      userName: display?.name,
      userEmail: display?.email,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      isPlatformOwner: tenant.isPlatformOwner,
      branding,
      perms: [...perms],
      can: (code: string) => cmsCan(perms, code),
    };

    return next();
  }

  // ---- Engineering Rhythm guard (/engr routes) -----------------------------
  if (pathname !== '/engr' && !pathname.startsWith('/engr/')) return next();

  const appPath = toAppPath(pathname);
  context.locals.engrPath = appPath;

  if (isPublicAppPath(appPath)) return next();
  const isApi = isEngrApiPath(appPath);

  let env: ReturnType<typeof getEngrEnv>;
  try {
    env = getEngrEnv();
  } catch {
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

  let actingOrgId = homeOrgId;
  let actingName: string = homeName;
  let actingSlug = homeSlug;
  let switchable: SwitchOrg[] = [];
  const isPlatformOwner = session.isPlatformOwner === true;
  if (isPlatformOwner) {
    try {
      const requested = await readActingOrg(context.request, env.sessionSecret);
      const db = await getEngrDb(env);
      const ctx = await resolveActingContext(db, homeOrgId, homeName, homeSlug, true, requested);
      actingOrgId = ctx.actingOrgId;
      actingName = ctx.actingName;
      actingSlug = ctx.actingSlug;
      switchable = ctx.switchable;
    } catch {
      actingOrgId = homeOrgId;
    }
  }

  const perms = session.perms;
  context.locals.engr = {
    userId: session.sub,
    orgId: actingOrgId,
    homeOrgId,
    orgSlug: actingSlug,
    orgName: actingName,
    userName: session.userName,
    userEmail: session.userEmail,
    isPlatformOwner,
    switchable,
    roles: session.roles,
    perms,
    can: (key: string) => perms.includes(key),
  };

  return next();
});
