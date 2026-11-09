import { defineMiddleware } from 'astro:middleware';
import { getEngrEnv } from '@engr/env';
import { getDb as getEngrDb } from '@engr/db';
import { clearSession, readSession } from '@engr/auth/session';
import { passwordGateDecision } from '@engr/auth/passwordGate';
import {
  hasSensitiveGrant,
  isPrivilegedAuthPath,
  isSensitiveMutationPath,
  mfaPathAllowed,
  requiredMfaStage,
  safeMfaNext,
} from '@engr/auth/mfaGate';
import { readActingOrg } from '@engr/auth/actingOrg';
import { resolveActingContext, type SwitchOrg } from '@engr/repos/orgContext';
import { loadUserAuth } from '@engr/auth/rbac';
import { SESSION_IDLE_SECONDS, type SessionPrivilege } from '@engr/auth/trackedSession';
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
  if (!session.sessionId) {
    const headers = { 'set-cookie': clearSession(secure) };
    return isApi
      ? new Response(JSON.stringify({ error: 'unauthorised' }), {
          status: 401,
          headers: { ...headers, 'content-type': 'application/json' },
        })
      : new Response(null, { status: 303, headers: { ...headers, location: '/login' } });
  }
  const current = await db.execute({
    sql: `SELECT u.status, u.deleted_at, u.must_change_password, u.session_version,
                 u.is_platform_owner, o.status AS org_status, o.deleted_at AS org_deleted_at,
                 s.session_version AS tracked_version, s.privilege_level, s.last_seen_at,
                 s.expires_at, s.revoked_at,
                 EXISTS(SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL) AS mfa_enabled
            FROM users u
            JOIN organisations o ON o.id = u.org_id
            JOIN auth_sessions s ON s.user_id = u.id AND s.org_id = u.org_id
           WHERE u.id = ? AND u.org_id = ? AND s.id = ? LIMIT 1`,
    args: [session.sub, session.org, session.sessionId],
  });
  const account = current.rows[0];
  const now = Date.now();
  const level = String(account?.privilege_level ?? '') as SessionPrivilege;
  const idleSeconds = SESSION_IDLE_SECONDS[level] ?? 0;
  const lastSeen = Date.parse(String(account?.last_seen_at ?? ''));
  const expired = Date.parse(String(account?.expires_at ?? '')) <= now;
  const idleExpired = !lastSeen || !idleSeconds || now - lastSeen > idleSeconds * 1000;
  const validAccount =
    account &&
    String(account.status) === 'ACTIVE' &&
    account.deleted_at === null &&
    String(account.org_status) === 'ACTIVE' &&
    account.org_deleted_at === null &&
    account.revoked_at === null &&
    !expired &&
    !idleExpired &&
    Number(account.session_version ?? 0) === (session.sessionVersion ?? 0) &&
    Number(account.tracked_version ?? 0) === (session.sessionVersion ?? 0);
  if (!validAccount) {
    if (account && account.revoked_at === null) {
      await db.execute({
        sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ?
               WHERE id = ? AND revoked_at IS NULL`,
        args: [
          new Date().toISOString(),
          idleExpired ? 'idle timeout' : 'session invalidated',
          session.sessionId,
        ],
      });
    }
    const headers = { 'set-cookie': clearSession(secure) };
    return isApi
      ? new Response(JSON.stringify({ error: 'unauthorised' }), {
          status: 401,
          headers: { ...headers, 'content-type': 'application/json' },
        })
      : new Response(null, { status: 303, headers: { ...headers, location: '/login' } });
  }

  // Permissions and roles are intentionally loaded from the current database,
  // never trusted from a twelve-hour-old JWT. Refresh last_seen sparingly.
  const currentAuth = await loadUserAuth(db, session.org, session.sub);
  const touchAfter = level === 'PRIVILEGED' ? 60_000 : 5 * 60_000;
  if (now - lastSeen >= touchAfter) {
    const pending = db.execute({
      sql: `UPDATE auth_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL`,
      args: [new Date(now).toISOString(), session.sessionId],
    });
    context.locals.cfContext?.waitUntil(pending.then(() => undefined).catch(() => undefined));
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
  const administrator = currentAuth.roles.includes('OWNER') || currentAuth.roles.includes('ADMIN');
  const mandatoryMfa = platformOwner || administrator || hasSensitiveGrant(currentAuth.perms);
  const mfaEnabled = Number(account.mfa_enabled ?? 0) === 1;
  const mfaVerifiedAt = session.mfaVerifiedAt ?? 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sensitiveMutation = isSensitiveMutationPath(appPath, context.request.method);
  const privilegedPath = isPrivilegedAuthPath(appPath) || sensitiveMutation;
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
      if (
        isApi &&
        !(sensitiveMutation && context.request.headers.get('accept')?.includes('text/html'))
      ) {
        return jsonResponse(
          { error: mfaRequirement === 'enroll' ? 'mfa_enrollment_required' : 'mfa_required' },
          403,
        );
      }
      const destination = mfaRequirement === 'enroll' ? '/mfa/enroll' : '/mfa/challenge';
      let nextPath = privilegedPath && !isApi ? appPath : '/';
      if (sensitiveMutation) {
        const referrer = context.request.headers.get('referer');
        if (referrer) {
          try {
            const parsed = new URL(referrer);
            if (parsed.origin === context.url.origin)
              nextPath = safeMfaNext(parsed.pathname, context.url.origin);
          } catch {
            // Ignore invalid or cross-origin referrers.
          }
        }
      }
      const location =
        mfaRequirement === 'challenge'
          ? `${destination}?next=${encodeURIComponent(safeMfaNext(nextPath, context.url.origin))}`
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

  const perms = currentAuth.perms;
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
    roles: currentAuth.roles,
    perms,
    mfaEnabled,
    mfaVerifiedAt,
    can: (key: string) => perms.includes(key),
  };

  return next();
});
