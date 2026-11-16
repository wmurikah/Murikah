import { defineMiddleware } from 'astro:middleware';
import { getGrcEnv } from '@grc/env';
import { getDb as getGrcDb } from '@grc/db';
import { readGrcSessionCookie } from '@grc/auth/session';
import { readActingOrg as readGrcActingOrg } from '@grc/auth/actingOrg';
import { readRolePreview } from '@grc/auth/rolePreview';
import { resolveSession } from '@grc/repos/session';
import {
  resolveActingContext as resolveGrcActingContext,
  type SwitchOrg as GrcSwitchOrg,
} from '@grc/repos/orgContext';
import { resolveRoleAccess, deriveLegacyPerms, canMatrix } from '@grc/auth/rbac';
import { resolveAffiliateScope } from '@grc/auth/affiliateScope';
import { isGroupAffiliate } from '@grc/repos/affiliatesAdmin';
import { resolveRolePreview } from '@grc/repos/rolePreview';
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
      if (env.mfaEnabled && sessionCookie.mfa === 'pending') {
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

      // A platform owner may preview an ordinary role inside the selected
      // instance. The signed cookie is revalidated against the live role and
      // affiliate rows on every request. It changes effective access only; the
      // underlying user, session and database role remain untouched.
      // Preview entitlement comes from the signed-in account, never from the
      // effective preview role. Selecting SUPER_ADMIN in preview therefore
      // cannot grant this capability to an ordinary account.
      const canRolePreview = identity.isPlatformOwner || identity.roleCode === 'SUPER_ADMIN';
      const requestedPreview =
        canRolePreview && instanceSelected
          ? await readRolePreview(context.request, env.sessionSecret)
          : null;
      const rolePreview =
        canRolePreview && instanceSelected
          ? await resolveRolePreview(db, organizationId, requestedPreview)
          : null;
      const effectiveRoleCode = rolePreview?.roleCode ?? identity.roleCode;
      const effectiveAffiliateCode = rolePreview?.affiliateCode ?? identity.affiliateCode;
      // Owner bypass must be disabled in preview, otherwise the menu might say
      // "Auditee" while every gate still grants platform-owner access.
      const effectivePlatformOwner = identity.isPlatformOwner && rolePreview === null;

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
        effectiveRoleCode,
        organizationId,
        effectivePlatformOwner,
      );
      const matrix = access.matrix;
      // The Group exemption (Build Prompt 48): a user posted to an affiliate
      // marked `affiliates.is_group` sees every affiliate even under a confined
      // role. Resolved once here, from the user's own affiliate, never per row,
      // and only asked for when a confinement would otherwise bite: an
      // unconfined request makes no extra query at all.
      const onGroupAffiliate =
        access.scopeToAffiliate && effectiveAffiliateCode
          ? await isGroupAffiliate(db, organizationId, effectiveAffiliateCode)
          : false;
      const affiliateScope = resolveAffiliateScope(
        access.scopeToAffiliate,
        effectiveAffiliateCode,
        effectivePlatformOwner,
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
        roleCode: effectiveRoleCode,
        userName: identity.userName,
        userEmail: identity.userEmail,
        isPlatformOwner: effectivePlatformOwner,
        isPlatformOwnerAccount: identity.isPlatformOwner,
        canRolePreview,
        rolePreview,
        mustChangePassword: identity.mustChangePassword,
        affiliateScope,
        switchable,
        matrix,
        perms,
        features,
        can: (action: string, module: string) => canMatrix(matrix, action, module),
        // A platform owner is entitled to every feature regardless of the acting
        // organisation's plan; an ordinary user is gated by their plan flags.
        hasFeature: (flag: string) => effectivePlatformOwner || features[flag] === true,
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
        if (rolePreview && appPath === GRC_PLATFORM_PATH) return context.redirect('/');
      } else if (appPath === GRC_PLATFORM_PATH) {
        return isApi ? jsonResponse({ error: 'forbidden' }, 403) : context.redirect('/');
      }

      // Preview is deliberately observational. Forms and action buttons may be
      // visible exactly as that role sees them, but mutation endpoints refuse
      // the write so the owner cannot accidentally change live data while
      // testing a persona. Starting, changing or ending preview and signing out
      // remain available.
      if (
        rolePreview &&
        isApi &&
        !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method.toUpperCase()) &&
        !new Set([
          '/api/role-preview/set',
          '/api/role-preview/clear',
          '/api/auth/logout',
        ]).has(appPath)
      ) {
        return jsonResponse({ error: 'role_preview_read_only' }, 403);
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

  return next();
});
