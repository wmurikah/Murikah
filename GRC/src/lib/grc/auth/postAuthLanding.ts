import type { Client } from '@libsql/client/web';
import type { SessionIdentity } from '@grc/repos/session';
import { defaultLandingPath, isAuditeeRole } from '@grc/dashboard/roleNav';
import { hasMyOverdue } from '@grc/repos/dashboard';
import { getScopedRoleMatrix } from '@grc/auth/rbac';
import { resolveAffiliateScope } from '@grc/auth/affiliateScope';
import { safeNextPath } from '@grc/routing';

/** Resolve the safe destination shared by password-only and MFA sign-in. */
export async function postAuthLanding(
  db: Client,
  identity: SessionIdentity,
  requested: unknown,
): Promise<string> {
  const intended = safeNextPath(requested);
  if (intended) return intended;

  let hasOverdue = false;
  if (!identity.isPlatformOwner && isAuditeeRole(identity.roleCode)) {
    const access = await getScopedRoleMatrix(db, identity.roleCode, identity.homeOrganizationId);
    const scope = resolveAffiliateScope(
      access.scopeToAffiliate,
      identity.affiliateCode,
      identity.isPlatformOwner,
    );
    hasOverdue = await hasMyOverdue(db, identity.homeOrganizationId, identity.userId, scope);
  }

  return defaultLandingPath(identity.roleCode, identity.isPlatformOwner, hasOverdue);
}
