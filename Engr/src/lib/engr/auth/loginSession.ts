import type { Client } from '@libsql/client/web';
import { loadUserAuth } from './rbac';
import { createSession, type SessionPayload } from './session';

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

function privileged(roles: string[], platformOwner: boolean): boolean {
  return platformOwner || roles.includes('OWNER') || roles.includes('ADMIN');
}

export async function fullSession(
  db: Client,
  identity: LoginIdentity,
  sessionSecret: string,
  secure: boolean,
  mfaVerifiedAt?: number,
): Promise<string> {
  const auth = await loadUserAuth(db, identity.orgId, identity.userId);
  return createSession(
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
  );
}

export async function sessionAfterPrimaryAuth(
  db: Client,
  identity: LoginIdentity,
  sessionSecret: string,
  secure: boolean,
): Promise<{ cookie: string; location: string }> {
  const auth = await loadUserAuth(db, identity.orgId, identity.userId);
  const mfa = await db.execute({
    sql: `SELECT enabled_at FROM user_mfa WHERE user_id = ? LIMIT 1`,
    args: [identity.userId],
  });
  const mfaEnabled = mfa.rows[0]?.enabled_at != null;
  let authStage: SessionPayload['authStage'];
  let location = '/';
  if (privileged(auth.roles, identity.isPlatformOwner) && !mfaEnabled) {
    authStage = 'mfa-enroll';
    location = '/mfa/enroll';
  } else if (mfaEnabled) {
    authStage = 'mfa-challenge';
    location = '/mfa/challenge';
  }
  if (!authStage) {
    return {
      cookie: await fullSession(db, identity, sessionSecret, secure),
      location,
    };
  }
  return {
    cookie: await createSession(
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
    ),
    location,
  };
}
