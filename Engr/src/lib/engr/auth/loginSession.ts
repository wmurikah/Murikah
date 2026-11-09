import type { Client } from '@libsql/client/web';
import { loadUserAuth } from './rbac';
import type { SessionPayload } from './session';
import { createTrackedSession } from './trackedSession';
import { hasSensitiveGrant } from './mfaGate.ts';
import { mfaEnforced } from './mfaPolicy.ts';

export interface LoginIdentity {
  userId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  userName?: string;
  userEmail: string;
  isPlatformOwner: boolean;
  sessionVersion: number;
}

function privileged(roles: string[], perms: string[], platformOwner: boolean): boolean {
  return (
    platformOwner || roles.includes('OWNER') || roles.includes('ADMIN') || hasSensitiveGrant(perms)
  );
}

export async function fullSession(
  db: Client,
  identity: LoginIdentity,
  sessionSecret: string,
  secure: boolean,
  mfaVerifiedAt?: number,
  request?: Request,
): Promise<string> {
  const auth = await loadUserAuth(db, identity.orgId, identity.userId);
  return createTrackedSession(
    db,
    {
      sub: identity.userId,
      org: identity.orgId,
      orgSlug: identity.orgSlug,
      orgName: identity.orgName,
      userName: identity.userName,
      userEmail: identity.userEmail,
      roles: auth.roles,
      perms: auth.perms,
      isPlatformOwner: identity.isPlatformOwner,
      sessionVersion: identity.sessionVersion,
      mfaVerifiedAt,
    },
    sessionSecret,
    secure,
    request,
  );
}

export async function sessionAfterPrimaryAuth(
  db: Client,
  identity: LoginIdentity,
  sessionSecret: string,
  secure: boolean,
  request?: Request,
): Promise<{ cookie: string; location: string }> {
  const auth = await loadUserAuth(db, identity.orgId, identity.userId);
  const enforced = await mfaEnforced(db, identity.orgId);
  if (!enforced) {
    return {
      cookie: await fullSession(db, identity, sessionSecret, secure, undefined, request),
      location: '/',
    };
  }
  const mfa = await db.execute({
    sql: `SELECT enabled_at FROM user_mfa WHERE user_id = ? LIMIT 1`,
    args: [identity.userId],
  });
  const mfaEnabled = mfa.rows[0]?.enabled_at != null;
  let authStage: SessionPayload['authStage'];
  let location = '/';
  if (privileged(auth.roles, auth.perms, identity.isPlatformOwner) && !mfaEnabled) {
    authStage = 'mfa-enroll';
    location = '/mfa/enroll';
  } else if (mfaEnabled) {
    authStage = 'mfa-challenge';
    location = '/mfa/challenge';
  }
  if (!authStage) {
    return {
      cookie: await fullSession(db, identity, sessionSecret, secure, undefined, request),
      location,
    };
  }
  return {
    cookie: await createTrackedSession(
      db,
      {
        sub: identity.userId,
        org: identity.orgId,
        orgSlug: identity.orgSlug,
        orgName: identity.orgName,
        userName: identity.userName,
        userEmail: identity.userEmail,
        roles: [],
        perms: [],
        isPlatformOwner: identity.isPlatformOwner,
        sessionVersion: identity.sessionVersion,
        authStage,
      },
      sessionSecret,
      secure,
      request,
    ),
    location,
  };
}
