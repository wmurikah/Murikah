/**
 * SUPER_ADMIN access-control administration: read the roles and their permission
 * matrix, and write a role's whole matrix to role_permissions. The permission
 * model is shared reference data (not tenant data), keyed by role_code,
 * module_code and action_code, so this is not organisation-scoped. SUPER_ADMIN is
 * never modified here; it always holds the full matrix.
 *
 * The save is one atomic batch, and it replaces rather than patches (Build Prompt
 * 43). The screen submits the entire matrix, so the honest statement of intent is
 * "these are the role's grants", not fifty-four independent edits. What it
 * replaced was a fifty-four iteration UPDATE-then-INSERT loop: up to 108 serial
 * round trips from a Worker, no transaction, and a partial-write window that left
 * a role in a state the administrator never chose and could not see (AC-03).
 *
 * The statements themselves live in the pure leaf permissionGrants.ts, so their
 * order and content are unit-tested without a database.
 */
import type { Client } from '@libsql/client/web';
import { buildMatrix, type PermissionMatrix, type MatrixRow } from '@grc/auth/rbac';
import { buildRoleMatrixStatements, type GrantInput } from './permissionGrants';

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

/** One role's permission matrix, read fresh from role_permissions. */
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

export { buildRoleMatrixStatements };
export type { GrantInput, GrantStatement } from './permissionGrants';

/**
 * Write a role's whole permission matrix in one atomic batch. Throws on failure,
 * having changed nothing: the caller reports the cause to the administrator.
 */
export async function saveRoleMatrix(
  db: Client,
  roleCode: string,
  grants: readonly GrantInput[],
): Promise<void> {
  await db.batch(buildRoleMatrixStatements(roleCode, grants), 'write');
}
