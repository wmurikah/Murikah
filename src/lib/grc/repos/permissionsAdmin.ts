/**
 * SUPER_ADMIN access-control administration: read the roles and their permission
 * matrix, and write a grant to role_permissions. The permission model is shared
 * reference data (not tenant data), keyed by role_code, module_code and
 * action_code, so this is not organisation-scoped. SUPER_ADMIN is never modified
 * here; it always holds the full matrix. The write itself invalidates the role's
 * cached matrix, so the change takes effect on the next request no matter which
 * path performed it; callers may still invalidate again, which costs nothing.
 */
import type { Client } from '@libsql/client/web';
import { buildMatrix, type PermissionMatrix, type MatrixRow } from '@grc/auth/rbac';
import { invalidateRoleMatrix } from '@grc/cache/invalidate';

/** The role codes, from the roles table, falling back to those with grants. */
export async function listRoleCodes(db: Client): Promise<string[]> {
  try {
    const res = await db.execute({
      sql: `SELECT role_code FROM roles ORDER BY role_code`,
      args: [],
    });
    const codes = res.rows.map((r) => String(r.role_code)).filter(Boolean);
    if (codes.length > 0) return codes;
  } catch {
    // fall back to the roles that carry grants
  }
  const res = await db.execute({
    sql: `SELECT DISTINCT role_code FROM role_permissions ORDER BY role_code`,
    args: [],
  });
  return res.rows.map((r) => String(r.role_code)).filter(Boolean);
}

/** One role's permission matrix, read fresh (not the request cache). */
export async function getRoleMatrix(db: Client, roleCode: string): Promise<PermissionMatrix> {
  const res = await db.execute({
    sql: `SELECT module_code, action_code, is_allowed
            FROM role_permissions WHERE role_code = ?`,
    args: [roleCode],
  });
  const rows: MatrixRow[] = res.rows.map((r) => ({
    moduleCode: String(r.module_code ?? ''),
    actionCode: String(r.action_code ?? ''),
    isAllowed: Number(r.is_allowed ?? 0) === 1,
  }));
  return buildMatrix(rows);
}

/**
 * Set one grant, updating the row if present or inserting it otherwise, then
 * invalidate that role's cached matrix. The invalidation lives inside the write
 * rather than beside it, so an access change cannot be left cached by a write
 * path that forgot to clear it.
 */
export async function setGrant(
  db: Client,
  roleCode: string,
  moduleCode: string,
  actionCode: string,
  isAllowed: boolean,
): Promise<void> {
  const flag = isAllowed ? 1 : 0;
  const upd = await db.execute({
    sql: `UPDATE role_permissions SET is_allowed = ?
            WHERE role_code = ? AND module_code = ? AND action_code = ?`,
    args: [flag, roleCode, moduleCode, actionCode],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO role_permissions (role_code, module_code, action_code, is_allowed)
            VALUES (?, ?, ?, ?)`,
      args: [roleCode, moduleCode, actionCode, flag],
    });
  }
  await invalidateRoleMatrix(roleCode);
}
