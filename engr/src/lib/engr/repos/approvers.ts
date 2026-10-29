/**
 * Users in an org who hold a given permission key, for notifying the right
 * approvers at each ladder level. Org-scoped; matches system roles (org_id IS
 * NULL) and org-custom roles.
 */
import type { SqlExecutor } from '../notify';

export async function usersWithPermission(
  db: SqlExecutor,
  orgId: string,
  permissionKey: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT u.id AS id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            JOIN role_permissions rp ON rp.role_id = r.id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE u.org_id = ? AND u.status = 'ACTIVE'
             AND p.key = ? AND (r.org_id IS NULL OR r.org_id = ?)`,
    args: [orgId, permissionKey, orgId],
  });
  return res.rows.map((row) => String(row.id));
}
