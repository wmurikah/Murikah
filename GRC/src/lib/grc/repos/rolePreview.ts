/** Server-side validation for a platform owner's requested role preview. */
import type { Client } from '@libsql/client/web';
import type { RequestedRolePreview } from '@grc/auth/rolePreview';

export async function resolveRolePreview(
  db: Client,
  organizationId: string,
  requested: RequestedRolePreview | null,
): Promise<RequestedRolePreview | null> {
  if (!requested || !organizationId) return null;
  const role = await db.execute({
    sql: `SELECT role_code FROM roles WHERE role_code = ? LIMIT 1`,
    args: [requested.roleCode],
  });
  if (role.rows.length === 0) return null;

  if (requested.affiliateCode) {
    const affiliate = await db.execute({
      sql: `SELECT affiliate_code FROM affiliates
             WHERE organization_id = ? AND affiliate_code = ?
               AND is_active = 1 AND deleted_at IS NULL LIMIT 1`,
      args: [organizationId, requested.affiliateCode],
    });
    if (affiliate.rows.length === 0) return null;
  }
  return requested;
}
