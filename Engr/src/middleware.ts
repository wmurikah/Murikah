import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { getDb as getEngrDb } from '@engr/db';
import { clearSession, readSession } from '@engr/auth/session';
import { passwordGateDecision } from '@engr/auth/passwordGate';
import { isPrivilegedAuthPath, mfaPathAllowed, requiredMfaStage } from '@engr/auth/mfaGate';
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

  const secure = context.url.protocol === 'https:';
  const db = await getEngrDb(env);
  const current = await db.execute({
    sql: `SELECT status, deleted_at, must_change_password, session_version, is_platform_owner,
                 EXISTS(SELECT 1 FROM user_mfa m WHERE m.user_id = users.id AND m.enabled_at IS NOT NULL) AS mfa_enabled
            FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [session.sub, session.org],
  });
  const account = current.rows[0];
  const validAccount =
    account &&
    String(account.status) === 'ACTIVE' &&
    account.deleted_at === null &&
    Number(account.session_version ?? 0) === (session.sessionVersion ?? 0);
  if (!validAccount) {
    const headers = { 'set-cookie': clearSession(secure) };
    return isApi
      ? new Response(JSON.stringify({ error: 'unauthorised' }), {
          status: 401,
          headers: { ...headers, 'content-type': 'application/json' },
        })
      : new Response(null, { status: 303, headers: { ...headers, location: '/login' } });
  }

  const passwordChangeRequired = Number(account.must_change_password ?? 0) === 1;
  const gate = passwordGateDecision(
    passwordChangeRequired,
    session.passwordChangeOnly === true || session.authStage === 'password-change',
    appPath,
    isApi,
  );
  if (gate !== 'allow') {
    return gate === 'forbid'
      ? jsonResponse({ error: 'password_change_required' }, 403)
      : context.redirect('/change-password');
  }
  if (
    passwordChangeRequired ||
    session.passwordChangeOnly ||
    session.authStage === 'password-change'
  ) {
    // Restricted sessions never receive application locals, roles, tenant
    // switching, or permission-bearing repository access.
    return next();
  }

  const platformOwner = Number(account.is_platform_owner ?? 0) === 1;
  const administrator = session.roles.includes('OWNER') || session.roles.includes('ADMIN');
  const mandatoryMfa = platformOwner || administrator;
  const mfaEnabled = Number(account.mfa_enabled ?? 0) === 1;
  const mfaVerifiedAt = session.mfaVerifiedAt ?? 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const privilegedPath = isPrivilegedAuthPath(appPath);
  const mfaRequirement = requiredMfaStage({
    authStage: session.authStage,
    mandatory: mandatoryMfa,
    enabled: mfaEnabled,
    verifiedAt: mfaVerifiedAt,
    now: nowSeconds,
    privilegedPath,
  });
  if (mfaRequirement) {
    if (!mfaPathAllowed(mfaRequirement, appPath)) {
      if (isApi) {
        return jsonResponse(
          { error: mfaRequirement === 'enroll' ? 'mfa_enrollment_required' : 'mfa_required' },
          403,
        );
      }
      const destination = mfaRequirement === 'enroll' ? '/mfa/enroll' : '/mfa/challenge';
      const location =
        mfaRequirement === 'challenge' && privilegedPath
          ? `${destination}?next=${encodeURIComponent(appPath)}`
          : destination;
      return context.redirect(location);
    }
    return next();
  }

  const homeOrgId = session.org;
  const homeName = session.orgName ?? session.orgSlug;
  const homeSlug = session.orgSlug;

  let actingOrgId = homeOrgId;
  let actingName: string = homeName;
  let actingSlug = homeSlug;
  let switchable: SwitchOrg[] = [];
  const isPlatformOwner = platformOwner;
  if (isPlatformOwner) {
    try {
      const requested = await readActingOrg(context.request, env.sessionSecret);
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
