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
import { resolveRoleAccess, deriveLegacyPerms, canMatrix } from '@grc/auth/rbac';
import { resolveAffiliateScope } from '@grc/auth/affiliateScope';
import { isGroupAffiliate } from '@grc/repos/affiliatesAdmin';
import { pageAccess, pageSlugForPath } from '@grc/auth/matrix';
import { loadSubscription } from '@grc/repos/features';
import {
  toGrcAppPath,
  isGrcPublicPath,
  safeNextPath,
  isGrcApiPath,
  isGrcChangePasswordExempt,
  isGrcMfaPendingAllowed,
  isGrcInstanceFreePath,
  GRC_CHANGE_PASSWORD_PATH,
  GRC_MFA_PATH,
  GRC_PLATFORM_PATH,
} from '@grc/routing';
import { logGrcError, grcErrorResponse } from '@grc/errorBoundary';
import { scheduleCacheStatsRollUp } from '@grc/cache';
import { toCmsAppPath } from '@/lib/hosts/cms';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb as getCmsDb } from '@/lib/cms/db';
import { readSessionCookie as readCmsSessionCookie } from '@/lib/cms/auth/cookie';
import { resolveSession as resolveCmsSession } from '@/lib/cms/auth/loginFlow';
import { clearSessionCookie as clearCmsCookie, isSecureRequest } from '@/lib/cms/auth/cookie';
import {
  isPublicPath as isCmsPublicPath,
  isApiPath as isCmsApiPath,
  isAppPath,
  isPortalPath,
  homeFor,
  APP_ROOT,
  PORTAL_ROOT,
  LOGIN_PATH,
  EXPIRED_FLAG,
} from '@/lib/cms/routes';

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

      // Where they were going, carried through sign-in (Build Prompt 53). A
      // digest email links a reviewer straight at the review queue, and losing
      // that destination at the guard is what makes an emailed link feel
      // broken. safeNextPath refuses anything that is not a path inside this
      // app, so this can never become an open redirect.
      const intended = safeNextPath(appPath + (context.url.search ?? ''));
      const toLogin = (): Response =>
        context.redirect(intended ? `/login?next=${encodeURIComponent(intended)}` : '/login');

      const sessionCookie = await readGrcSessionCookie(context.request, env.sessionSecret);
      if (!sessionCookie) {
        return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : toLogin();
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
        return isApi ? jsonResponse({ error: 'unauthorised' }, 401) : toLogin();
      }

      // An instance admin, and every other ordinary role, is pinned to their home
      // organisation: no cookie is read and no switch is possible. A platform
      // owner is pinned to nothing, so their acting organisation is whichever
      // instance they have entered, resolved and validated from the database, and
      // null until they choose one. It never falls back to their home
      // organisation: being an owner of the platform is not membership of a
      // customer's instance.
      let organizationId = identity.homeOrganizationId;
      let organizationName = identity.homeOrganizationName;
      let switchable: GrcSwitchOrg[] = [];
      let instanceSelected = true;
      if (identity.isPlatformOwner) {
        const requested = await readGrcActingOrg(context.request, env.sessionSecret);
        const acting = await resolveGrcActingContext(
          db,
          identity.homeOrganizationId,
          identity.homeOrganizationName,
          true,
          requested,
        );
        instanceSelected = acting.actingOrganizationId !== null;
        // With no instance selected the acting organisation id is empty: it
        // matches no row, so even a query that slipped past the gate below reads
        // nothing rather than another organisation's data.
        organizationId = acting.actingOrganizationId ?? '';
        organizationName = acting.actingName ?? 'All organisations';
        switchable = acting.switchable;
      }

      // The permission matrix from role_permissions drives every gate. A SUPER_ADMIN
      // and a platform owner hold the full matrix; every other role holds its grants,
      // resolved inside the acting organisation (its own rows if it has any, else the
      // platform defaults), so one customer's grants never answer for another's.
      // The legacy perms list is derived from the matrix, so existing code keeps
      // working, matrix-driven.
      // The second dimension of access beside the grants (Build Prompt 45): a
      // role can be confined to its user's affiliate. Both come from the one
      // query, so the grants and the scope can never disagree. A SUPER_ADMIN and
      // a platform owner hold a synthesised matrix and are never confined.
      // Resolved through the shared accessor (Build Prompt 57), which every
      // other gate in the product also asks, so the session and a save behind it
      // can never resolve the same role differently.
      const access = await resolveRoleAccess(
        db,
        identity.roleCode,
        organizationId,
        identity.isPlatformOwner,
      );
      const matrix = access.matrix;
      // The Group exemption (Build Prompt 48): a user posted to an affiliate
      // marked `affiliates.is_group` sees every affiliate even under a confined
      // role. Resolved once here, from the user's own affiliate, never per row,
      // and only asked for when a confinement would otherwise bite: an
      // unconfined request makes no extra query at all.
      const onGroupAffiliate =
        access.scopeToAffiliate && identity.affiliateCode
          ? await isGroupAffiliate(db, organizationId, identity.affiliateCode)
          : false;
      const affiliateScope = resolveAffiliateScope(
        access.scopeToAffiliate,
        identity.affiliateCode,
        identity.isPlatformOwner,
        onGroupAffiliate,
      );
      const perms = deriveLegacyPerms(matrix);
      // With no instance selected there is no subscription to read: the plan
      // belongs to the instance, not to the platform owner browsing above it.
      const features = instanceSelected
        ? (await loadSubscription(db, organizationId)).features
        : {};

      context.locals.grc = {
        userId: identity.userId,
        organizationId,
        homeOrganizationId: identity.homeOrganizationId,
        organizationName,
        instanceSelected,
        roleCode: identity.roleCode,
        userName: identity.userName,
        userEmail: identity.userEmail,
        isPlatformOwner: identity.isPlatformOwner,
        mustChangePassword: identity.mustChangePassword,
        affiliateScope,
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

      // The instance gate (Build Prompt 38). A platform owner with no instance
      // selected has no acting organisation, so every module path is sent to the
      // all-instances view to pick one rather than erroring or being defaulted
      // into an organisation they did not choose. Only the owner is ever in this
      // state; an instance admin is pinned and passes straight through. The
      // mirror case keeps the all-instances view to the owner: nobody else has
      // one, so it is not a page they can reach.
      if (identity.isPlatformOwner) {
        if (!instanceSelected && !isGrcInstanceFreePath(appPath)) {
          return isApi
            ? jsonResponse({ error: 'instance_required' }, 409)
            : context.redirect(GRC_PLATFORM_PATH);
        }
      } else if (appPath === GRC_PLATFORM_PATH) {
        return isApi ? jsonResponse({ error: 'forbidden' }, 403) : context.redirect('/');
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
    } finally {
      // Fold this isolate's cache counters into the shared roll-up, after the
      // response is decided and through waitUntil where the platform offers one,
      // so the platform owner's diagnostics never sit in a user's critical path.
      // Throttled internally, so calling it every request costs almost nothing.
      scheduleCacheStatsRollUp(context.locals.cfContext?.waitUntil.bind(context.locals.cfContext));
    }
  }

  // ---- CMS host branch (/cms routes) ---------------------------------------
  // The branch itself is unchanged from Build Prompt 00, so cms.murikah.com
  // keeps resolving and the Cloudflare custom domain never has to be
  // re-pointed. Inside it, this is the whole of the CMS's route protection.
  //
  // Server-side, by redirect. There are no client-side guards anywhere in this
  // product, and no client-side authentication store: the principal is resolved
  // here, once per request, and read from locals by whatever renders. That is
  // why a refresh keeps the user signed in with no code, why there is no
  // loading state to design, and why protected markup can never flash on an
  // unauthorised screen: it is never sent.
  //
  // The public list is default-deny (see @/lib/cms/routes): a page added later
  // is protected because nobody had to remember to protect it.
  if (pathname === '/cms' || pathname.startsWith('/cms/')) {
    const appPath = toCmsAppPath(pathname);
    context.locals.cmsPath = appPath;

    const isApi = isCmsApiPath(appPath);
    let anonymousReason: string = 'no_cookie';

    try {
      const env = getCmsEnv();
      const db = await getCmsDb(env);
      const resolution = await resolveCmsSession(
        db,
        env.sessionSecret,
        readCmsSessionCookie(context.request),
        new Date(),
      );
      if (resolution.kind === 'authenticated') {
        context.locals.cms = {
          sessionId: resolution.sessionId,
          user: resolution.identity,
          can: (code: string) => resolution.identity.permissions.includes(code),
        };
      } else {
        anonymousReason = resolution.reason;
      }
    } catch {
      // Anonymous. An unconfigured TURSO_CMS_* or an unreachable database must
      // not take the host down: the sign-in page and the static assets have no
      // business depending on the database being up.
    }

    const principal = context.locals.cms;

    // A page response for a signed-in user must never be cached. Without this,
    // the Back button can redisplay the shell from the browser's cache after
    // sign-out, which looks exactly like still being signed in.
    const guarded = async (): Promise<Response> => {
      if (principal) {
        // Signed in. Send each user type to its own surface, and keep them
        // there. The sign-in page is not somewhere a signed-in user belongs.
        const home = homeFor(principal.user.userType);
        if (appPath === LOGIN_PATH) return context.redirect(home, 302);
        if (appPath === '/') return context.redirect(home, 302);
        if (principal.user.userType === 'EXTERNAL' && isAppPath(appPath)) {
          // Never rendered, not merely hidden.
          return context.redirect(PORTAL_ROOT, 302);
        }
        if (principal.user.userType === 'INTERNAL' && isPortalPath(appPath)) {
          // The decision: staff are sent to /app rather than shown the portal.
          // The portal is the customer's surface and a staff user has no
          // customer_portal_memberships row, so it would render an empty shell
          // and invite confusion about which surface they are on. One home per
          // user type is easier to reason about than a read-only visit.
          return context.redirect(APP_ROOT, 302);
        }
        return next();
      }

      // Not signed in.
      if (isCmsPublicPath(appPath)) return next();

      // An API answers for itself: a JSON client wants 401, not the HTML of a
      // sign-in page delivered under a 302 it did not ask to follow.
      if (isApi) return next();

      // A session that ran out gets told so; one that never existed does not.
      const expired = anonymousReason === 'expired' || anonymousReason === 'revoked';
      const destination = expired ? `${LOGIN_PATH}?${EXPIRED_FLAG}=1` : LOGIN_PATH;
      const response = context.redirect(destination, 302);
      // Clear the dead cookie on the way past, so the browser stops sending a
      // credential that will never work again.
      if (anonymousReason !== 'no_cookie') {
        response.headers.append(
          'set-cookie',
          clearCmsCookie({ secure: isSecureRequest(context.request) }),
        );
      }
      return response;
    };

    const response = await guarded();
    if (principal) response.headers.set('cache-control', 'no-store');
    return response;
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
